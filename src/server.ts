import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { timingSafeEqual } from "node:crypto";
import type { AuthManager } from "./auth";
import { settings, type UnifySettings } from "./config";
import { ProviderError, startProvider, type GatewayEvent, type ProviderStream } from "./providers";

type Json = Record<string, unknown>;
type ProviderStarter = (body: Json, auth: AuthManager, config: UnifySettings) => Promise<ProviderStream>;

export interface UsageSample {
  model: string;
  input: number;
  output: number;
  prompts?: number;
  prompt?: string;
  result?: string;
}

const MAX_BODY = 8 * 1024 * 1024;
const MAX_ACTIVE = 4;
const MAX_PER_MINUTE = 90;

function authorized(header: string | undefined, expected: string): boolean {
  const value = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

async function body(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_BODY) throw new ProviderError(413, "Request is too large.");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json;
  } catch {
    throw new ProviderError(400, "Request body must be valid JSON.");
  }
}

function originalPrompt(payload: Json): string {
  if (typeof payload.prompt === "string") return payload.prompt;
  if (typeof payload.input === "string") return payload.input;
  const items = Array.isArray(payload.messages)
    ? payload.messages
    : Array.isArray(payload.input)
      ? payload.input
      : [];
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index] as Json;
    if (item?.role !== "user") continue;
    if (typeof item.content === "string") return item.content;
    if (Array.isArray(item.content)) {
      return item.content
        .map((part) => typeof part === "object" && part && "text" in part ? String((part as Json).text ?? "") : "")
        .join("");
    }
  }
  return "";
}

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

function resultText(content: string, calls: Map<number, ToolCall>): string {
  const tools = [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
  if (!tools.length) return content;
  const raw = JSON.stringify({ tool_calls: tools }, null, 2);
  return content ? `${content}\n\n${raw}` : raw;
}

function chunk(stream: ProviderStream, delta: Json, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: stream.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: stream.model,
    choices: [{ index: 0, delta, finish_reason: finish }]
  })}\n\n`;
}

async function write(response: ServerResponse, value: string): Promise<void> {
  if (!response.write(value)) await once(response, "drain");
}

export class GatewayServer {
  private server?: Server;
  private active = 0;
  private minute = 0;
  private minuteStarted = Date.now();

  constructor(
    private readonly auth: AuthManager,
    private readonly getKey: () => Promise<string>,
    private readonly log: (message: string) => void,
    private readonly start: ProviderStarter = startProvider,
    private readonly used: (sample: UsageSample) => void = () => {}
  ) {}

  async listen(port = 47822): Promise<boolean> {
    if (this.server) return true;
    const server = createServer((request, response) => void this.handle(request, response));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      this.server = server;
      this.log(`Inference gateway ready on 127.0.0.1:${port}`);
      return true;
    } catch (error) {
      try {
        server.close();
      } catch {}
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        this.log(`Local port ${port} is already in use.`);
        return false;
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  port(): number | undefined {
    const address = this.server?.address();
    return typeof address === "object" && address ? address.port : undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("content-security-policy", "default-src 'none'");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const key = await this.getKey();
      if (request.headers.origin) throw new ProviderError(403, "Browser-origin requests are not allowed.");
      if (!authorized(request.headers.authorization, key)) throw new ProviderError(401, "Invalid Unify key.");
      this.checkLimits();

      if (request.method === "GET" && url.pathname === "/v1/models") {
        const config = settings();
        this.json(response, 200, {
          object: "list",
          data: config.models
            .filter((model) => model.enabled)
            .map((model) => ({
              id: model.frontend,
              object: "model",
              owned_by: model.provider,
              upstream: model.backend
            }))
        });
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
        throw new ProviderError(404, "Route not found.");
      }
      if (this.active >= MAX_ACTIVE) throw new ProviderError(429, "Too many active requests.");
      this.active++;
      try {
        const payload = await body(request);
        const config = settings();
        const stream = config.deepPrompt
          ? await this.deep(payload, config)
          : await this.start(payload, this.auth, config);
        const prompt = originalPrompt(payload);
        if (payload.stream === true) {
          await this.streaming(response, stream, prompt);
        } else {
          await this.buffered(response, stream, prompt);
        }
      } finally {
        this.active--;
      }
    } catch (error) {
      const status = error instanceof ProviderError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Unify request failed.";
      if (response.headersSent) {
        await write(response, `data: ${JSON.stringify({ error: { type: "api_error", message } })}\n\ndata: [DONE]\n\n`);
        response.end();
      } else {
        this.json(response, status, { error: { type: status === 401 ? "authentication_error" : "api_error", message } });
      }
    }
  }

  private async deep(payload: Json, config: UnifySettings): Promise<ProviderStream> {
    const writer = await this.start(payload, this.auth, config);
    const start = this.start;
    const auth = this.auth;
    const record = (usage: { input: number; output: number }) => this.record(writer.model, usage, 0);
    const prompt = originalPrompt(payload);
    async function* events(): AsyncGenerator<GatewayEvent> {
      const captured: GatewayEvent[] = [];
      let output = "";
      let usage = { input: 0, output: 0 };
      let finish: GatewayEvent["finish"];
      let usedTools = false;
      for await (const event of writer.events) {
        captured.push(event);
        if (event.content) output += event.content;
        if (event.tool) usedTools = true;
        if (event.finish) finish = event.finish;
        if (event.usage) usage = {
          input: Math.max(usage.input, event.usage.input),
          output: Math.max(usage.output, event.usage.output)
        };
      }
      if (usedTools || finish === "tool_calls" || finish === "length" || !output) {
        for (const event of captured) yield event;
        return;
      }
      record(usage);
      const source = Array.isArray(payload.messages)
        ? payload.messages
        : Array.isArray(payload.input)
          ? payload.input
          : [];
      const context = source.filter((item) => {
        if (!item || typeof item !== "object") return false;
        const role = (item as Json).role;
        return role === "system" || role === "developer";
      });
      const validatorPayload: Json = {
        ...payload,
        model: config.deepPromptValidator,
        messages: [
          ...context,
          {
            role: "developer",
            content: "Validate the coding agent's final response. Return only the final response Cursor should display. If it is correct, return it unchanged. Otherwise rewrite it in the same concise, completed-work style. Never mention validation, the original output, or a modified result. Never provide code as a substitute for work the agent did not complete."
          },
          {
            role: "user",
            content: `Original request:\n${prompt}\n\nAgent response:\n${output}`
          }
        ]
      };
      delete validatorPayload.tools;
      delete validatorPayload.tool_choice;
      const validator = await start(validatorPayload, auth, config);
      for await (const event of validator.events) yield event;
    }
    return {
      id: writer.id,
      model: writer.model,
      events: events()
    };
  }

  private async streaming(response: ServerResponse, stream: ProviderStream, prompt: string): Promise<void> {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive"
    });
    response.flushHeaders();
    await write(response, chunk(stream, { role: "assistant", content: "" }));
    let finished = false;
    let content = "";
    let usage = { input: 0, output: 0 };
    const calls = new Map<number, ToolCall>();
    for await (const event of stream.events) {
      if (event.content) {
        content += event.content;
        await write(response, chunk(stream, { content: event.content }));
      }
      if (event.usage) usage = {
        input: Math.max(usage.input, event.usage.input),
        output: Math.max(usage.output, event.usage.output)
      };
      if (event.tool) {
        const current = calls.get(event.tool.index) ?? {
          id: event.tool.id ?? "",
          type: "function",
          function: { name: event.tool.name ?? "", arguments: "" }
        };
        if (event.tool.id) current.id = event.tool.id;
        if (event.tool.name) current.function.name = event.tool.name;
        if (event.tool.arguments) current.function.arguments += event.tool.arguments;
        calls.set(event.tool.index, current);
        await write(response, chunk(stream, {
          tool_calls: [{
            index: event.tool.index,
            id: event.tool.id,
            type: event.tool.name ? "function" : undefined,
            function: {
              name: event.tool.name,
              arguments: event.tool.arguments
            }
          }]
        }));
      }
      if (event.finish) {
        finished = true;
        await write(response, chunk(stream, {}, event.finish));
      }
    }
    if (!finished) await write(response, chunk(stream, {}, "stop"));
    await write(response, "data: [DONE]\n\n");
    response.end();
    this.record(stream.model, usage, 1, prompt, resultText(content, calls));
  }

  private async buffered(response: ServerResponse, stream: ProviderStream, prompt: string): Promise<void> {
    let content = "";
    let finish = "stop";
    let usage = { input: 0, output: 0 };
    const calls = new Map<number, ToolCall>();
    for await (const event of stream.events) {
      if (event.content) content += event.content;
      if (event.finish) finish = event.finish;
      if (event.usage) usage = {
        input: Math.max(usage.input, event.usage.input),
        output: Math.max(usage.output, event.usage.output)
      };
      if (event.tool) {
        const current = calls.get(event.tool.index) ?? {
          id: event.tool.id ?? "",
          type: "function",
          function: { name: event.tool.name ?? "", arguments: "" }
        };
        if (event.tool.id) current.id = event.tool.id;
        if (event.tool.name) current.function.name = event.tool.name;
        if (event.tool.arguments) current.function.arguments += event.tool.arguments;
        calls.set(event.tool.index, current);
      }
    }
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
    this.json(response, 200, {
      id: stream.id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: stream.model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {})
        },
        finish_reason: finish
      }],
      usage: {
        prompt_tokens: usage.input,
        completion_tokens: usage.output,
        total_tokens: usage.input + usage.output
      }
    });
    this.record(stream.model, usage, 1, prompt, resultText(content, calls));
  }

  private record(model: string, usage: { input: number; output: number }, prompts = 1, prompt?: string, result?: string): void {
    if (prompts > 0 || usage.input > 0 || usage.output > 0) {
      this.used({ model, ...usage, ...(prompts === 1 ? {} : { prompts }), ...(prompt === undefined ? {} : { prompt, result }) });
    }
  }

  private checkLimits(): void {
    const now = Date.now();
    if (now - this.minuteStarted >= 60_000) {
      this.minuteStarted = now;
      this.minute = 0;
    }
    if (++this.minute > MAX_PER_MINUTE) throw new ProviderError(429, "Request rate limit reached.");
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  }
}

export async function probe(port: number, key: string): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(1000)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export { authorized };

import { randomUUID } from "node:crypto";
import type { AuthManager, Provider } from "./auth";
import type { ModelConfig, UnifySettings } from "./config";

type Json = Record<string, unknown>;

export interface GatewayEvent {
  content?: string;
  tool?: {
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  };
  finish?: "stop" | "tool_calls" | "length";
  usage?: {
    input: number;
    output: number;
  };
}

export interface ProviderStream {
  id: string;
  model: string;
  events: AsyncGenerator<GatewayEvent>;
}

export class ProviderError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === "object") : [];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  return records(value)
    .map((part) => {
      if (typeof part.text === "string") return part.text;
      if (typeof part.content === "string") return part.content;
      return "";
    })
    .join("");
}

function messages(body: Json): Json[] {
  if (Array.isArray(body.messages)) return records(body.messages);
  const output: Json[] = [];
  for (const item of records(body.input)) {
    if (item.type === "message") {
      output.push({ role: item.role, content: item.content });
    } else if (item.type === "function_call") {
      output.push({
        role: "assistant",
        content: "",
        tool_calls: [{
          id: item.call_id ?? item.id,
          type: "function",
          function: { name: item.name, arguments: item.arguments ?? "" }
        }]
      });
    } else if (item.type === "function_call_output") {
      output.push({ role: "tool", tool_call_id: item.call_id, content: item.output ?? "" });
    }
  }
  return output;
}

function tools(body: Json): Json[] {
  return records(body.tools).map((tool) => {
    const fn = tool.function as Json | undefined;
    if (tool.type === "function" && fn) {
      return {
        type: "function",
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters ?? { type: "object", properties: {} },
        strict: fn.strict
      };
    }
    return tool;
  });
}

export function providerFor(model: unknown): Provider {
  const value = String(model ?? "").toLowerCase();
  return value.includes("chatgpt") || value.startsWith("gpt-") ? "chatgpt" : "claude";
}

export function resolveModel(model: unknown, config: UnifySettings): ModelConfig {
  const enabled = config.models.filter((item) => item.enabled);
  const requested = String(model ?? "").trim();
  const match = enabled.find((item) => item.frontend === requested)
    ?? enabled.find((item) => item.frontend.toLowerCase() === requested.toLowerCase())
    ?? (!requested ? enabled[0] : undefined);
  if (!match) throw new ProviderError(400, `Unknown or disabled model: ${requested || "(empty)"}.`);
  return match;
}

export async function startProvider(
  body: Json,
  auth: AuthManager,
  config: UnifySettings
): Promise<ProviderStream> {
  const model = resolveModel(body.model, config);
  return model.provider === "chatgpt"
    ? startChatGPT(body, auth, model, config)
    : startClaude(body, auth, model, config);
}

async function startClaude(
  body: Json,
  auth: AuthManager,
  model: ModelConfig,
  config: UnifySettings
): Promise<ProviderStream> {
  const credentials = await auth.token("claude");
  const source = messages(body);
  const system = source
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => text(message.content))
    .filter(Boolean);
  const claudeMessages = mergeClaudeMessages(source
    .filter((message) => message.role !== "system" && message.role !== "developer")
    .map(toClaudeMessage));
  const requestTools = tools(body).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters
  }));
  const request: Json = {
    model: model.backend,
    stream: true,
    max_tokens: typeof body.max_tokens === "number"
      ? body.max_tokens
      : typeof body.max_completion_tokens === "number"
        ? body.max_completion_tokens
        : 32768,
    system: [
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
      ...system.map((value) => ({ type: "text", text: value }))
    ],
    messages: claudeMessages.length ? claudeMessages : [{ role: "user", content: "Hello." }],
    thinking: { type: "adaptive" },
    output_config: { effort: config.reasoning }
  };
  if (config.speed === "fast") request.speed = "fast";
  if (requestTools.length) {
    request.tools = requestTools;
    request.tool_choice = claudeToolChoice(body.tool_choice);
  }
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.accessToken}`,
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14",
      accept: "text/event-stream"
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10 * 60_000)
  });
  await assertOk(response, "Claude");
  return {
    id: `chatcmpl-${randomUUID()}`,
    model: model.frontend,
    events: claudeEvents(response.body!)
  };
}

function mergeClaudeMessages(source: Json[]): Json[] {
  const result: Json[] = [];
  for (const message of source) {
    const previous = result.at(-1);
    if (previous && previous.role === message.role) {
      previous.content = [...records(previous.content), ...records(message.content)];
    } else {
      result.push({ ...message, content: records(message.content) });
    }
  }
  return result;
}

function claudeToolChoice(value: unknown): Json {
  if (typeof value === "string") {
    return { type: value === "required" ? "any" : value };
  }
  const choice = value as Json | undefined;
  const fn = choice?.function as Json | undefined;
  if (choice?.type === "function" && typeof fn?.name === "string") {
    return { type: "tool", name: fn.name };
  }
  return choice ?? { type: "auto" };
}

function toClaudeMessage(message: Json): Json {
  if (message.role === "tool") {
    return {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: text(message.content)
      }]
    };
  }
  const content: Json[] = [];
  for (const part of typeof message.content === "string" ? [{ type: "text", text: message.content }] : records(message.content)) {
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      content.push({ type: "text", text: part.text ?? "" });
    }
    if (part.type === "image_url") {
      const url = typeof part.image_url === "string"
        ? part.image_url
        : String((part.image_url as Json | undefined)?.url ?? "");
      const data = /^data:([^;]+);base64,(.+)$/.exec(url);
      content.push(data
        ? { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } }
        : { type: "image", source: { type: "url", url } });
    }
  }
  for (const call of records(message.tool_calls)) {
    const fn = call.function as Json | undefined;
    let input: unknown = {};
    try {
      input = JSON.parse(String(fn?.arguments ?? "{}"));
    } catch {}
    content.push({ type: "tool_use", id: call.id, name: fn?.name, input });
  }
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: content.length ? content : [{ type: "text", text: "" }]
  };
}

async function* claudeEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<GatewayEvent> {
  const toolIndexes = new Map<number, number>();
  let nextTool = 0;
  let usedTools = false;
  for await (const event of sse(body)) {
    if (event.type === "content_block_start") {
      const block = event.content_block as Json | undefined;
      if (block?.type === "text" && typeof block.text === "string" && block.text) {
        yield { content: block.text };
      }
      if (block?.type === "tool_use") {
        const sourceIndex = Number(event.index ?? 0);
        const index = nextTool++;
        toolIndexes.set(sourceIndex, index);
        usedTools = true;
        yield { tool: { index, id: String(block.id ?? ""), name: String(block.name ?? ""), arguments: "" } };
      }
    }
    if (event.type === "content_block_delta") {
      const delta = event.delta as Json | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") yield { content: delta.text };
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        yield { tool: { index: toolIndexes.get(Number(event.index ?? 0)) ?? 0, arguments: delta.partial_json } };
      }
    }
    if (event.type === "message_delta") {
      const delta = event.delta as Json | undefined;
      const usage = event.usage as Json | undefined;
      if (usage) yield { usage: { input: 0, output: Number(usage.output_tokens ?? 0) } };
      if (delta?.stop_reason) {
        yield { finish: delta.stop_reason === "max_tokens" ? "length" : usedTools ? "tool_calls" : "stop" };
      }
    }
    if (event.type === "message_start") {
      const message = event.message as Json | undefined;
      const usage = message?.usage as Json | undefined;
      if (usage) yield { usage: { input: Number(usage.input_tokens ?? 0), output: 0 } };
    }
    if (event.type === "error") {
      const error = event.error as Json | undefined;
      throw new ProviderError(502, String(error?.message ?? "Claude stream failed."));
    }
  }
}

async function startChatGPT(
  body: Json,
  auth: AuthManager,
  model: ModelConfig,
  config: UnifySettings
): Promise<ProviderStream> {
  const credentials = await auth.token("chatgpt");
  if (!credentials.accountId) throw new ProviderError(401, "Reconnect ChatGPT to select its account.");
  const source = messages(body);
  const instructions = source
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => text(message.content))
    .filter(Boolean)
    .join("\n\n") || "You are a coding assistant integrated with the user's editor.";
  const input = Array.isArray(body.input)
    ? records(body.input)
    : source
        .filter((message) => message.role !== "system" && message.role !== "developer")
        .flatMap(toResponsesItems);
  const request: Json = {
    model: model.backend,
    input: input.length ? input : [{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello." }] }],
    instructions,
    stream: true,
    store: false,
    reasoning: { effort: config.reasoning }
  };
  if (config.speed === "fast") request.service_tier = "priority";
  const requestTools = tools(body);
  if (requestTools.length) {
    request.tools = requestTools;
    request.tool_choice = body.tool_choice ?? "auto";
    request.parallel_tool_calls = false;
  }
  const response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.accessToken}`,
      "chatgpt-account-id": credentials.accountId,
      originator: "codex_cli_rs",
      "content-type": "application/json",
      accept: "text/event-stream"
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(10 * 60_000)
  });
  await assertOk(response, "ChatGPT");
  return {
    id: `chatcmpl-${randomUUID()}`,
    model: model.frontend,
    events: chatgptEvents(response.body!)
  };
}

function toResponsesItems(message: Json): Json[] {
  if (message.role === "tool") {
    return [{ type: "function_call_output", call_id: message.tool_call_id, output: text(message.content) }];
  }
  const result: Json[] = [];
  const role = message.role === "assistant" ? "assistant" : "user";
  const content = typeof message.content === "string"
    ? [{ type: role === "assistant" ? "output_text" : "input_text", text: message.content }]
    : records(message.content).map((part) => {
        if (part.type === "image_url") {
          const image = typeof part.image_url === "string"
            ? part.image_url
            : (part.image_url as Json | undefined)?.url;
          return { type: "input_image", image_url: image };
        }
        return { type: role === "assistant" ? "output_text" : "input_text", text: part.text ?? "" };
      });
  if (content.length || !Array.isArray(message.tool_calls)) result.push({ type: "message", role, content });
  for (const call of records(message.tool_calls)) {
    const fn = call.function as Json | undefined;
    result.push({
      type: "function_call",
      call_id: call.id,
      name: fn?.name,
      arguments: fn?.arguments ?? ""
    });
  }
  return result;
}

async function* chatgptEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<GatewayEvent> {
  const toolIndexes = new Map<string, number>();
  const toolArguments = new Map<string, number>();
  let nextTool = 0;
  let usedTools = false;
  for await (const event of sse(body)) {
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      yield { content: event.delta };
    }
    if (event.type === "response.output_item.added") {
      const item = event.item as Json | undefined;
      if (item?.type === "function_call") {
        const key = String(item.id ?? item.call_id ?? event.output_index ?? nextTool);
        const index = nextTool++;
        toolIndexes.set(key, index);
        toolArguments.set(key, 0);
        usedTools = true;
        yield {
          tool: {
            index,
            id: String(item.call_id ?? item.id ?? ""),
            name: String(item.name ?? ""),
            arguments: ""
          }
        };
      }
    }
    if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
      const key = String(event.item_id ?? event.call_id ?? event.output_index ?? "");
      toolArguments.set(key, (toolArguments.get(key) ?? 0) + event.delta.length);
      yield { tool: { index: toolIndexes.get(key) ?? Number(event.output_index ?? 0), arguments: event.delta } };
    }
    if (event.type === "response.output_item.done") {
      const item = event.item as Json | undefined;
      if (item?.type === "function_call") {
        const key = String(item.id ?? item.call_id ?? event.output_index ?? "");
        if ((toolArguments.get(key) ?? 0) === 0 && typeof item.arguments === "string" && item.arguments) {
          yield { tool: { index: toolIndexes.get(key) ?? Number(event.output_index ?? 0), arguments: item.arguments } };
        }
      }
    }
    if (event.type === "response.completed") {
      const response = event.response as Json | undefined;
      const usage = response?.usage as Json | undefined;
      if (usage) {
        yield { usage: { input: Number(usage.input_tokens ?? 0), output: Number(usage.output_tokens ?? 0) } };
      }
      yield { finish: usedTools ? "tool_calls" : "stop" };
    }
    if (event.type === "response.failed" || event.type === "error") {
      const error = (event.response as Json | undefined)?.error as Json | undefined
        ?? event.error as Json | undefined;
      throw new ProviderError(502, String(error?.message ?? "ChatGPT stream failed."));
    }
  }
}

async function assertOk(response: Response, provider: string): Promise<void> {
  if (response.ok && response.body) return;
  const raw = (await response.text()).slice(0, 600);
  let message = `${provider} request failed (${response.status}).`;
  try {
    const parsed = JSON.parse(raw) as Json;
    const error = parsed.error as Json | undefined;
    message = String(error?.message ?? parsed.message ?? parsed.detail ?? message);
  } catch {}
  throw new ProviderError(response.status || 502, message);
}

export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data) as Json;
        } catch {}
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

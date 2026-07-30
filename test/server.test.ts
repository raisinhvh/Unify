import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AuthManager } from "../src/auth";
import { updateSettings } from "../src/config";
import { GatewayServer, authorized } from "../src/server";
import type { ProviderStream } from "../src/providers";

const servers: GatewayServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function* events() {
  yield { content: "ok" };
  yield { finish: "stop" as const };
}

describe("inference gateway", () => {
  it("uses exact constant-time bearer matching", () => {
    expect(authorized("Bearer secret", "secret")).toBe(true);
    expect(authorized("Bearer secre", "secret")).toBe(false);
    expect(authorized("Basic secret", "secret")).toBe(false);
  });

  it("keeps control routes unreachable", async () => {
    const starter = async (): Promise<ProviderStream> => ({
      id: "test",
      model: "unify-chatgpt",
      events: events()
    });
    const server = new GatewayServer({} as AuthManager, async () => "secret", () => {}, starter);
    servers.push(server);
    expect(await server.listen(0)).toBe(true);
    const base = `http://127.0.0.1:${server.port()}`;

    expect((await fetch(`${base}/v1/models`)).status).toBe(401);
    expect((await fetch(`${base}/settings`, { headers: { authorization: "Bearer secret" } })).status).toBe(404);
    expect((await fetch(`${base}/v1/models`, {
      headers: { authorization: "Bearer secret", origin: "https://attacker.example" }
    })).status).toBe(403);

    const models = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer secret" } });
    expect(models.status).toBe(200);
    expect(await models.json()).toMatchObject({
      data: [
        { id: "Sonnet 5", owned_by: "claude" },
        { id: "Fable 5", owned_by: "claude" },
        { id: "Opus 5", owned_by: "claude" },
        { id: "Sol", owned_by: "chatgpt" },
        { id: "Terra", owned_by: "chatgpt" },
        { id: "Luna", owned_by: "chatgpt" }
      ]
    });
  });

  it("can recover on a free loopback port when the preferred port is occupied", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const address = blocker.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const gateway = new GatewayServer({} as AuthManager, async () => "secret", () => {});
    servers.push(gateway);
    try {
      expect(await gateway.listen(port)).toBe(false);
      expect(await gateway.listen(0)).toBe(true);
      expect(gateway.port()).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("records aggregate usage with plain-text history content", async () => {
    async function* usageEvents() {
      yield { usage: { input: 120, output: 30 } };
      yield { content: "ok" };
      yield { finish: "stop" as const };
    }
    const samples: Array<{ model: string; input: number; output: number; prompt?: string; result?: string }> = [];
    const starter = async (): Promise<ProviderStream> => ({
      id: "test",
      model: "5.6 Sol High",
      events: usageEvents()
    });
    const gateway = new GatewayServer(
      {} as AuthManager,
      async () => "secret",
      () => {},
      starter,
      (sample) => samples.push(sample)
    );
    servers.push(gateway);
    expect(await gateway.listen(0)).toBe(true);
    const response = await fetch(`http://127.0.0.1:${gateway.port()}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "5.6 Sol High", messages: [{ role: "user", content: "Hello." }] })
    });
    expect(response.status).toBe(200);
    expect(samples).toEqual([{
      model: "5.6 Sol High",
      input: 120,
      output: 30,
      prompt: "Hello.",
      result: "ok"
    }]);
  });

  it("runs Deep Prompt through a writer and validator", async () => {
    await updateSettings({
      deepPrompt: true,
      deepPromptValidator: "Terra"
    });
    const calls: Array<Record<string, unknown>> = [];
    const samples: Array<{ model: string; input: number; output: number; prompts?: number; prompt?: string; result?: string }> = [];
    const starter = async (payload: Record<string, unknown>): Promise<ProviderStream> => {
      calls.push(payload);
      const writer = calls.length === 1;
      async function* pass() {
        yield { content: writer ? "draft" : "validated" };
        yield { usage: writer ? { input: 10, output: 5 } : { input: 20, output: 7 } };
        yield { finish: "stop" as const };
      }
      return {
        id: writer ? "writer" : "validator",
        model: String(payload.model),
        events: pass()
      };
    };
    const gateway = new GatewayServer(
      {} as AuthManager,
      async () => "secret",
      () => {},
      starter,
      (sample) => samples.push(sample)
    );
    servers.push(gateway);
    try {
      expect(await gateway.listen(0)).toBe(true);
      const response = await fetch(`http://127.0.0.1:${gateway.port()}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({
          model: "Luna",
          messages: [
            { role: "system", content: "You are Cursor's coding agent." },
            { role: "developer", content: "Report completed work concisely." },
            { role: "user", content: "Build it." }
          ],
          tools: [{ type: "function", function: { name: "edit", parameters: {} } }]
        })
      });
      const result = await response.json() as { choices: Array<{ message: { content: string } }> };
      expect(result.choices[0]?.message.content).toBe("validated");
      expect(calls[0]).toMatchObject({ model: "Luna", tools: [{ type: "function" }] });
      expect(calls[1]).toMatchObject({ model: "Terra" });
      expect(calls[1]?.tools).toBeUndefined();
      expect(calls[1]?.messages).toMatchObject([
        { role: "system", content: "You are Cursor's coding agent." },
        { role: "developer", content: "Report completed work concisely." },
        { role: "developer" },
        { role: "user", content: "Original request:\nBuild it.\n\nAgent response:\ndraft" }
      ]);
      expect(JSON.stringify(calls[1]?.messages)).toContain("Return only the final response Cursor should display.");
      expect(samples).toEqual([
        { model: "Luna", input: 10, output: 5, prompts: 0 },
        { model: "Luna", input: 20, output: 7, prompt: "Build it.", result: "validated" }
      ]);
    } finally {
      await updateSettings({ deepPrompt: false });
    }
  });

  it("passes Deep Prompt tool calls through without validation", async () => {
    await updateSettings({
      deepPrompt: true,
      deepPromptValidator: "Terra"
    });
    const calls: Array<Record<string, unknown>> = [];
    const starter = async (payload: Record<string, unknown>): Promise<ProviderStream> => {
      calls.push(payload);
      async function* pass() {
        yield { tool: { index: 0, id: "call-1", name: "search", arguments: "{\"path\":\"src\"}" } };
        yield { usage: { input: 8, output: 4 } };
        yield { finish: "tool_calls" as const };
      }
      return { id: "writer", model: String(payload.model), events: pass() };
    };
    const gateway = new GatewayServer({} as AuthManager, async () => "secret", () => {}, starter);
    servers.push(gateway);
    try {
      expect(await gateway.listen(0)).toBe(true);
      const response = await fetch(`http://127.0.0.1:${gateway.port()}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({
          model: "Luna",
          messages: [{ role: "user", content: "Inspect the project." }],
          tools: [{ type: "function", function: { name: "search", parameters: {} } }]
        })
      });
      const result = await response.json() as { choices: Array<{ finish_reason: string; message: { tool_calls: unknown[] } }> };
      expect(result.choices[0]?.finish_reason).toBe("tool_calls");
      expect(result.choices[0]?.message.tool_calls).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.tools).toBeDefined();
    } finally {
      await updateSettings({ deepPrompt: false });
    }
  });
});

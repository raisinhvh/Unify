import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthManager } from "../src/auth";
import { DEFAULT_MODELS, type UnifySettings } from "../src/config";
import { providerFor, resolveModel, sse, startProvider } from "../src/providers";

const config: UnifySettings = {
  tunnelMode: "prompt",
  cursorUrlMode: "prompt",
  theme: "dark",
  synapses: true,
  reasoning: "high",
  speed: "standard",
  models: DEFAULT_MODELS,
  localMode: false,
  deepPrompt: false,
  deepPromptValidator: "Sol"
};

describe("provider routing", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("routes aliases and direct model IDs", () => {
    expect(providerFor("unify-chatgpt")).toBe("chatgpt");
    expect(providerFor("gpt-5.6")).toBe("chatgpt");
    expect(providerFor("unify-claude")).toBe("claude");
    expect(providerFor("claude-opus-4-8")).toBe("claude");
    expect(resolveModel("Luna", config)).toMatchObject({
      provider: "chatgpt",
      backend: "gpt-5.6-luna"
    });
  });

  it("applies Unify's effort and fast settings to provider requests", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }));
    const auth = {
      token: vi.fn(async (provider: string) => provider === "chatgpt"
        ? { accessToken: "chatgpt-token", accountId: "account" }
        : { accessToken: "claude-token" })
    } as unknown as AuthManager;
    const routed: UnifySettings = {
      ...config,
      reasoning: "xhigh",
      speed: "fast",
      models: [
        DEFAULT_MODELS[0]!,
        DEFAULT_MODELS[3]!
      ]
    };

    await startProvider({ model: "Sonnet 5", messages: [{ role: "user", content: "Hello" }] }, auth, routed);
    await startProvider({ model: "Sol", messages: [{ role: "user", content: "Hello" }] }, auth, routed);

    expect(requests[0]?.url).toContain("anthropic.com");
    expect(requests[0]?.body).toMatchObject({ speed: "fast", output_config: { effort: "xhigh" } });
    expect(requests[1]?.url).toContain("chatgpt.com");
    expect(requests[1]?.body).toMatchObject({ service_tier: "priority", reasoning: { effort: "xhigh" } });
  });

  it("parses SSE split across transport chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"first",'));
        controller.enqueue(encoder.encode('"value":1}\n\ndata: {"type":"second"}\n\n'));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    });
    const result = [];
    for await (const event of sse(stream)) result.push(event);
    expect(result).toEqual([{ type: "first", value: 1 }, { type: "second" }]);
  });
});

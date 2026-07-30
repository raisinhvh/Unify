import { describe, expect, it } from "vitest";
import { mergeUsage, UsageStore } from "../src/usage";

describe("usage aggregation", () => {
  it("aggregates token counts by day and model", () => {
    const first = mergeUsage([], { model: "5.6 Sol High", input: 100, output: 25 }, "chatgpt", Date.UTC(2026, 6, 27));
    const second = mergeUsage(first, { model: "5.6 Sol High", input: 10, output: 5 }, "chatgpt", Date.UTC(2026, 6, 27));
    expect(second).toEqual([{
      day: "2026-07-27",
      model: "5.6 Sol High",
      provider: "chatgpt",
      input: 110,
      output: 30,
      prompts: 2
    }]);
  });

  it("records an internal Deep Prompt pass without another user prompt", () => {
    const points = mergeUsage([], { model: "Sol", input: 100, output: 25, prompts: 0 }, "chatgpt", Date.UTC(2026, 6, 27));
    expect(points[0]).toMatchObject({ input: 100, output: 25, prompts: 0 });
  });

  it("keeps only the latest 10 user history entries", async () => {
    const values = new Map<string, unknown>();
    const state = {
      get: <T>(key: string, fallback: T): T => values.has(key) ? values.get(key) as T : fallback,
      update: async (key: string, value: unknown): Promise<void> => { values.set(key, value); }
    };
    const store = new UsageStore(state as never);
    for (let index = 0; index < 12; index++) {
      store.record({ model: `Model ${index}`, input: 1, output: 1, prompt: `Prompt ${index}`, result: `Result ${index}` }, "chatgpt");
    }
    store.record({ model: "Writer", input: 1, output: 1, prompts: 0 }, "chatgpt");
    const history = await store.history();
    expect(history).toHaveLength(10);
    expect(history[0]).toMatchObject({ model: "Model 11", prompt: "Prompt 11", result: "Result 11" });
    expect(history.some((entry) => entry.model === "Writer")).toBe(false);
  });
});

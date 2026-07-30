import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, normalizeModels, validReasoning, validateModels } from "../src/config";

describe("model settings", () => {
  it("allows the supported effort levels", () => {
    expect(validReasoning("max")).toBe(true);
    expect(validReasoning("xhigh")).toBe(true);
    expect(validReasoning("adaptive_max")).toBe(false);
    expect(validReasoning("max mode")).toBe(false);
  });

  it("drops obsolete per-model effort and speed values", () => {
    const oldModel = { ...DEFAULT_MODELS[0], reasoning: "low", speed: "fast" };
    expect(normalizeModels([oldModel])[0]).toEqual(DEFAULT_MODELS[0]);
  });

  it("updates the deprecated OpenAI default names", () => {
    expect(normalizeModels([
      { provider: "chatgpt", frontend: "5.6 Sol High", backend: "gpt-5.6-sol", enabled: true },
      { provider: "chatgpt", frontend: "5.6 Terra Medium", backend: "gpt-5.6-terra", enabled: true },
      { provider: "chatgpt", frontend: "5.6 Luna Low", backend: "gpt-5.6-luna", enabled: true }
    ]).map((model) => model.frontend)).toEqual(["Sol", "Terra", "Luna"]);
  });

  it("requires unique Cursor names", () => {
    expect(() => validateModels([
      { ...DEFAULT_MODELS[0]!, frontend: "Same" },
      { ...DEFAULT_MODELS[1]!, frontend: "same" }
    ])).toThrow(/unique/i);
  });
});

import * as vscode from "vscode";

export type TunnelMode = "manual" | "prompt" | "automatic";
export type CursorUrlMode = "prompt" | "automatic";
export type Theme = "default" | "dark" | "incognito" | "aquamint" | "sophisticated" | "violet" | "honeycomb" | "skid" | "light";
export type ModelProvider = "claude" | "chatgpt";
export type ModelEffort = "low" | "medium" | "high" | "max" | "xhigh";
export type ModelSpeed = "standard" | "fast";

export interface ModelConfig {
  provider: ModelProvider;
  frontend: string;
  backend: string;
  enabled: boolean;
}

export interface UnifySettings {
  tunnelMode: TunnelMode;
  cursorUrlMode: CursorUrlMode;
  theme: Theme;
  synapses: boolean;
  reasoning: ModelEffort;
  speed: ModelSpeed;
  models: ModelConfig[];
  localMode: boolean;
  deepPrompt: boolean;
  deepPromptValidator: string;
}

export const DEFAULT_MODELS: ModelConfig[] = [
  { provider: "claude", frontend: "Sonnet 5", backend: "claude-sonnet-5", enabled: true },
  { provider: "claude", frontend: "Fable 5", backend: "claude-fable-5", enabled: true },
  { provider: "claude", frontend: "Opus 5", backend: "claude-opus-5", enabled: true },
  { provider: "chatgpt", frontend: "Sol", backend: "gpt-5.6-sol", enabled: true },
  { provider: "chatgpt", frontend: "Terra", backend: "gpt-5.6-terra", enabled: true },
  { provider: "chatgpt", frontend: "Luna", backend: "gpt-5.6-luna", enabled: true }
];

const EFFORTS = new Set<ModelEffort>(["low", "medium", "high", "max", "xhigh"]);
const SPEEDS = new Set<ModelSpeed>(["standard", "fast"]);
const LEGACY_OPENAI_NAMES = new Map([
  ["5.6 Sol High:gpt-5.6-sol", "Sol"],
  ["5.6 Terra Medium:gpt-5.6-terra", "Terra"],
  ["5.6 Luna Low:gpt-5.6-luna", "Luna"]
]);

function isModel(value: unknown): value is ModelConfig {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<ModelConfig>;
  return (model.provider === "claude" || model.provider === "chatgpt")
    && typeof model.frontend === "string"
    && typeof model.backend === "string"
    && typeof model.enabled === "boolean";
}

export function normalizeModels(value: unknown): ModelConfig[] {
  if (!Array.isArray(value)) return DEFAULT_MODELS.map((model) => ({ ...model }));
  const models = value.filter(isModel).map((model) => ({
    provider: model.provider,
    frontend: model.provider === "chatgpt"
      ? LEGACY_OPENAI_NAMES.get(`${model.frontend.trim()}:${model.backend.trim()}`) ?? model.frontend.trim()
      : model.frontend.trim(),
    backend: model.backend.trim(),
    enabled: model.enabled
  }));
  return models.length ? models : DEFAULT_MODELS.map((model) => ({ ...model }));
}

export function settings(): UnifySettings {
  const c = vscode.workspace.getConfiguration("unify");
  const theme = c.get<string>("theme", "default");
  const reasoning = c.get<unknown>("reasoning", "high");
  const speed = c.get<unknown>("speed", "standard");
  return {
    tunnelMode: c.get<TunnelMode>("tunnelMode", "prompt"),
    cursorUrlMode: c.get<CursorUrlMode>("cursorUrlMode", "prompt"),
    theme: theme === "red" ? "default" : theme as Theme,
    synapses: c.get<boolean>("synapses", true),
    reasoning: typeof reasoning === "string" && validReasoning(reasoning)
      ? reasoning.trim().toLowerCase() as ModelEffort
      : "high",
    speed: validSpeed(speed) ? speed : "standard",
    models: normalizeModels(c.get<unknown>("models", DEFAULT_MODELS)),
    localMode: c.get<boolean>("localMode", false),
    deepPrompt: c.get<boolean>("deepPrompt", false),
    deepPromptValidator: c.get<string>("deepPromptValidator", "Sol").trim()
  };
}

export function validReasoning(value: unknown): value is ModelEffort {
  return typeof value === "string" && EFFORTS.has(value.trim().toLowerCase() as ModelEffort);
}

export function validSpeed(value: unknown): value is ModelSpeed {
  return typeof value === "string" && SPEEDS.has(value as ModelSpeed);
}

export function validateModels(models: ModelConfig[]): void {
  if (!models.length) throw new Error("Add at least one model.");
  if (!models.some((model) => model.enabled)) throw new Error("Show at least one model.");
  if (models.length > 30) throw new Error("Unify supports up to 30 models.");
  const names = new Set<string>();
  for (const model of models) {
    const frontend = model.frontend.trim();
    const backend = model.backend.trim();
    if (!frontend || frontend.length > 80) throw new Error("Every model needs a Cursor name under 81 characters.");
    if (!backend || backend.length > 160) throw new Error(`"${frontend}" needs a backend ID.`);
    const key = frontend.toLowerCase();
    if (names.has(key)) throw new Error(`Model names must be unique: "${frontend}".`);
    names.add(key);
  }
}

export async function updateSettings(next: Partial<UnifySettings>): Promise<void> {
  const c = vscode.workspace.getConfiguration("unify");
  for (const [key, value] of Object.entries(next)) {
    await c.update(key, value, vscode.ConfigurationTarget.Global);
  }
}

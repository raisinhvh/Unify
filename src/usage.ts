import * as vscode from "vscode";
import type { ModelEffort, ModelProvider, ModelSpeed } from "./config";
import type { UsageSample } from "./server";

const KEY = "unify.usage.v1";
const HISTORY_KEY = "unify.usageHistory.v1";
const KEEP_DAYS = 365;
const HISTORY_LIMIT = 10;

export interface UsagePoint extends UsageSample {
  day: string;
  provider: ModelProvider;
  prompts: number;
}

export interface UsageEntry extends UsageSample {
  time: number;
  provider: ModelProvider;
  effort?: ModelEffort;
  speed?: ModelSpeed;
}

function isoDay(time = Date.now()): string {
  return new Date(time).toISOString().slice(0, 10);
}

export function mergeUsage(
  points: UsagePoint[],
  sample: UsageSample,
  provider: ModelProvider,
  time = Date.now()
): UsagePoint[] {
  const day = isoDay(time);
  const cutoff = isoDay(time - (KEEP_DAYS - 1) * 86_400_000);
  const kept = points
    .filter((point) => point.day >= cutoff)
    .map((point) => ({ ...point, prompts: point.prompts ?? 0 }));
  const current = kept.find((point) => point.day === day && point.model === sample.model);
  if (current) {
    current.input += sample.input;
    current.output += sample.output;
    current.prompts += sample.prompts ?? 1;
    current.provider = provider;
  } else {
    kept.push({ day, model: sample.model, provider, input: sample.input, output: sample.output, prompts: sample.prompts ?? 1 });
  }
  return kept;
}

export class UsageStore {
  private queue = Promise.resolve();

  constructor(private readonly state: vscode.Memento) {}

  record(sample: UsageSample, provider: ModelProvider, effort?: ModelEffort, speed?: ModelSpeed): void {
    this.queue = this.queue.then(async () => {
      const points = this.state.get<UsagePoint[]>(KEY, []);
      const history = this.state.get<UsageEntry[]>(HISTORY_KEY, []);
      await this.state.update(KEY, mergeUsage(points, sample, provider));
      if (sample.prompts !== 0) {
        await this.state.update(HISTORY_KEY, [{ ...sample, provider, effort, speed, time: Date.now() }, ...history].slice(0, HISTORY_LIMIT));
      }
    });
  }

  async snapshot(): Promise<UsagePoint[]> {
    await this.queue;
    return this.state.get<UsagePoint[]>(KEY, []).map((point) => ({ ...point, prompts: point.prompts ?? 0 }));
  }

  async history(): Promise<UsageEntry[]> {
    await this.queue;
    const stored = this.state.get<UsageEntry[]>(HISTORY_KEY, []);
    const history = stored.slice(0, HISTORY_LIMIT);
    if (stored.length > HISTORY_LIMIT) await this.state.update(HISTORY_KEY, history);
    return history;
  }
}

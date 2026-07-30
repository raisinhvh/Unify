const values: Record<string, unknown> = {};

export const workspace = {
  getConfiguration: () => ({
    get: <T>(key: string, fallback: T): T => (values[key] as T | undefined) ?? fallback,
    update: async (key: string, value: unknown): Promise<void> => {
      values[key] = value;
    }
  })
};

export const ConfigurationTarget = { Global: 1 };

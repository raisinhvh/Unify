import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      vscode: resolve("test/vscode.ts")
    }
  },
  test: {
    clearMocks: true
  }
});

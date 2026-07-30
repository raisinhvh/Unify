import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node22",
  sourcemap: true
});

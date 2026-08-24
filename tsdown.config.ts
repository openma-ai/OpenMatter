import { defineConfig } from "tsdown";

export default defineConfig({
  workspace: {
    include: "auto",
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/test?(s)/**",
      "**/t?(e)mp/**",
      "docs-site/**",
    ],
  },
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "neutral",
  target: "es2022",
  dts: true,
  sourcemap: true,
  clean: true,
  checks: {
    pluginTimings: false,
  },
  deps: {
    neverBundle: true,
  },
});

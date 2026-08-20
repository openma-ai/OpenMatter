import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@openmatter/core": fromRoot("./packages/core/src/index.ts"),
      "@openmatter/store": fromRoot("./packages/store/src/index.ts"),
      "@openmatter/store-memory": fromRoot(
        "./packages/store-memory/src/index.ts",
      ),
      "@openmatter/integration": fromRoot(
        "./packages/integration/src/index.ts",
      ),
      "@openmatter/integration-mock": fromRoot(
        "./packages/integration-mock/src/index.ts",
      ),
      "@openmatter/agent": fromRoot("./packages/agent/src/index.ts"),
      "@openmatter/agent-mock": fromRoot("./packages/agent-mock/src/index.ts"),
      "@openmatter/runtime": fromRoot("./packages/runtime/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    pool: "threads",
  },
});

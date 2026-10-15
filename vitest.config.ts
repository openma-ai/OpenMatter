import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@openma/matter-core": fromRoot("./packages/core/src/index.ts"),
      "@openma/matter-credentials": fromRoot(
        "./packages/credentials/src/index.ts",
      ),
      "@openma/matter-bond": fromRoot("./packages/bond/src/index.ts"),
      "@openma/matter-bond-gitlab": fromRoot(
        "./packages/bond-gitlab/src/index.ts",
      ),
      "@openma/matter-store": fromRoot("./packages/store/src/index.ts"),
      "@openma/matter-store-memory": fromRoot(
        "./packages/store-memory/src/index.ts",
      ),
      "@openma/matter-store-sqlite": fromRoot(
        "./packages/store-sqlite/src/index.ts",
      ),
      "@openma/matter-store-mysql": fromRoot(
        "./packages/store-mysql/src/index.ts",
      ),
      "@openma/matter-inbox": fromRoot("./packages/inbox/src/index.ts"),
      "@openma/matter-inbox-sqlite": fromRoot(
        "./packages/inbox-sqlite/src/index.ts",
      ),
      "@openma/matter-integration": fromRoot(
        "./packages/integration/src/index.ts",
      ),
      "@openma/matter-integration-mock": fromRoot(
        "./packages/integration-mock/src/index.ts",
      ),
      "@openma/matter-integration-slack": fromRoot(
        "./packages/integration-slack/src/index.ts",
      ),
      "@openma/matter-integration-github": fromRoot(
        "./packages/integration-github/src/index.ts",
      ),
      "@openma/matter-integration-linear": fromRoot(
        "./packages/integration-linear/src/index.ts",
      ),
      "@openma/matter-agent": fromRoot("./packages/agent/src/index.ts"),
      "@openma/matter-agent-claude": fromRoot(
        "./packages/agent-claude/src/index.ts",
      ),
      "@openma/matter-agent-mock": fromRoot(
        "./packages/agent-mock/src/index.ts",
      ),
      "@openma/matter-runtime": fromRoot("./packages/runtime/src/index.ts"),
      "@openma/matter-host-cloudflare": fromRoot(
        "./packages/host-cloudflare/src/index.ts",
      ),
      "@openma/matter-host-local": fromRoot(
        "./packages/host-local/src/index.ts",
      ),
      "@openma/matter-orchestration": fromRoot(
        "./packages/orchestration/src/index.ts",
      ),
      "@openma/matter-project": fromRoot("./packages/project/src/index.ts"),
      "@openma/matter-project-host": fromRoot(
        "./packages/project-host/src/index.ts",
      ),
      "@openma/matter-project-mcp": fromRoot(
        "./packages/project-mcp/src/index.ts",
      ),
      "@openma/matter-project-worker": fromRoot(
        "./packages/project-worker/src/index.ts",
      ),
      "@openma/matter-http": fromRoot("./packages/http/src/index.ts"),
      "@openma/matter-fastify": fromRoot("./packages/fastify/src/index.ts"),
      "@openma/matter-hono": fromRoot("./packages/hono/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    pool: "threads",
  },
});

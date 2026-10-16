import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string) =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@openma\/matter$/,
        replacement: fromRoot("./packages/matter/src/index.ts"),
      },
      {
        find: /^@openma\/matter\/([a-z-]+)$/,
        replacement: fromRoot("./packages/matter/src") + "/$1/index.ts",
      },
      {
        find: /^@openma\/matter-([a-z]+)\/bond$/,
        replacement: fromRoot("./packages") + "/$1/src/bond/index.ts",
      },
      {
        find: /^@openma\/matter-loop$/,
        replacement: fromRoot("./packages/loop/src/index.ts"),
      },
      {
        find: /^@openma\/matter-agent-mock$/,
        replacement: fromRoot("./packages/agent-mock/src/index.ts"),
      },
      {
        find: /^@openma\/matter-fastify$/,
        replacement: fromRoot("./packages/fastify/src/index.ts"),
      },
      {
        find: /^@openma\/matter-hono$/,
        replacement: fromRoot("./packages/hono/src/index.ts"),
      },
      {
        find: /^@openma\/matter-host-cloudflare$/,
        replacement: fromRoot("./packages/host-cloudflare/src/index.ts"),
      },
      {
        find: /^@openma\/matter-host-local$/,
        replacement: fromRoot("./packages/host-local/src/index.ts"),
      },
      {
        find: /^@openma\/matter-host-local\/runtime$/,
        replacement: fromRoot("./packages/host-local/src/runtime/index.ts"),
      },
      {
        find: /^@openma\/matter-inbox-sqlite$/,
        replacement: fromRoot("./packages/inbox-sqlite/src/index.ts"),
      },
      {
        find: /^@openma\/matter-integration-mock$/,
        replacement: fromRoot("./packages/integration-mock/src/index.ts"),
      },
      {
        find: /^@openma\/matter-orchestration$/,
        replacement: fromRoot("./packages/orchestration/src/index.ts"),
      },
      {
        find: /^@openma\/matter-project$/,
        replacement: fromRoot("./packages/project/src/index.ts"),
      },
      {
        find: /^@openma\/matter-project-host$/,
        replacement: fromRoot("./packages/project-host/src/index.ts"),
      },
      {
        find: /^@openma\/matter-project-mcp$/,
        replacement: fromRoot("./packages/project-mcp/src/index.ts"),
      },
      {
        find: /^@openma\/matter-project-worker$/,
        replacement: fromRoot("./packages/project-worker/src/index.ts"),
      },
      {
        find: /^@openma\/matter-store-memory$/,
        replacement: fromRoot("./packages/store-memory/src/index.ts"),
      },
      {
        find: /^@openma\/matter-store-mysql$/,
        replacement: fromRoot("./packages/store-mysql/src/index.ts"),
      },
      {
        find: /^@openma\/matter-store-sqlite$/,
        replacement: fromRoot("./packages/store-sqlite/src/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    pool: "threads",
  },
});

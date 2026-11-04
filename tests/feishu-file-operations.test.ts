import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createOpenMatter } from "@openma/matter/runtime";
import { makeMockAgentDriver } from "@openma/matter-agent-mock";
import { makeMemoryStore } from "@openma/matter-store-memory";
import { makeFeishuIntegration } from "../packages/feishu/src/bond/index.js";

// Break caught: an upload helper that bypasses native grants/pending records can duplicate a non-idempotent upload.
describe("native Feishu file OperationCalls", () => {
  it.each(["delivered", "uncertain", "refused"] as const)(
    "records %s and never repeats the upload for the same callback",
    async (outcome) => {
      const store = makeMemoryStore();
      let uploads = 0;
      const integration = makeFeishuIntegration({
        credentials: { baseUrl: "https://open.feishu.cn", token: "token" },
        files: {
          resolve: () => ({
            authority: "app",
            filename: "file.html",
            mimeType: "text/html",
            bytes: new Uint8Array([1]),
          }),
        },
        fetch: async () => {
          uploads++;
          if (outcome === "uncertain") throw new Error("lost response");
          return new Response(
            JSON.stringify({ code: 0, data: { file_key: "file_uploaded" } }),
          );
        },
      });
      const call = {
        callId: "c1",
        integrationId: "feishu",
        operation: "file.upload",
        input: { authority: "app", resourceId: "artifact" },
      };
      const worker = makeMockAgentDriver({
        id: "worker",
        output: "done",
        operationCalls: [call, call],
      });
      const app = createOpenMatter({
        store,
        integrations: { feishu: integration },
        agents: { worker: worker.driver },
      });
      app.on("test", (work) =>
        Effect.gen(function* () {
          const allow = outcome === "refused" ? [] : ["feishu.file.upload"];
          const context = yield* work.context.project({
            scopeId: "scope",
            workThreadId: "thread",
            items: [work.context.event()],
            grants: allow,
          });
          yield* work
            .agent("worker")
            .session({
              scopeId: "scope",
              workThreadId: "thread",
              privacyPartition: "team",
            })
            .turn({ context, allow });
          return work.react.none();
        }),
      );
      await app.accept({
        schemaVersion: "0.1",
        id: "event",
        type: "test",
        occurredAt: "2026-01-01T00:00:00Z",
        receivedAt: "2026-01-01T00:00:00Z",
        idempotencyKey: "event",
        source: { provider: "test", authority: "app" },
        payload: {},
      });
      expect(uploads).toBe(outcome === "refused" ? 0 : 1);
      expect(worker.callbackResponses().map((r) => r.result)).toEqual([
        expect.objectContaining({ status: outcome }),
        expect.objectContaining({ status: outcome }),
      ]);
      expect(
        (await Effect.runPromise(store.inspect)).operationCalls,
      ).toHaveLength(1);
    },
  );
});

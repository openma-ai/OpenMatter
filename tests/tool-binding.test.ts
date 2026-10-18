import { describe, expect, it } from "vitest";
import { makeMockAgentDriver } from "@openma/matter-agent-mock";
import type {
  JsonValue,
  OperationCallResult,
  WorkEffect,
  WorkEvent,
} from "@openma/matter";
import type { WorkIntegration } from "@openma/matter/integration";
import { createOpenMatter } from "@openma/matter/runtime";
import { makeMemoryStore } from "@openma/matter-store-memory";
import { Effect } from "effect";

const ask: WorkEvent = {
  schemaVersion: "0.1",
  id: "ask",
  type: "chat.mention",
  occurredAt: "2026-08-20T08:00:00.000Z",
  receivedAt: "2026-08-20T08:00:01.000Z",
  idempotencyKey: "chat:ask",
  source: { provider: "chat", authority: "workspace-1", messageId: "m-ask" },
};

const run = async (
  bind: WorkIntegration["bindToolInput"],
  operation = "reply",
) => {
  const delivered: WorkEffect[] = [];
  const seen: { operation: string; input: JsonValue; trigger: string }[] = [];
  const chat: WorkIntegration = {
    manifest: {
      id: "chat",
      displayName: "Chat",
      events: ["chat.mention"],
      operations: ["reply", "react"],
      tools: { reply: { description: "Reply", inputSchema: {} } },
    },
    ingest: () => Effect.succeed([]),
    deliver: (effect) => {
      delivered.push(effect);
      return Effect.succeed({});
    },
    ...(bind === undefined
      ? {}
      : {
          bindToolInput: (op, input, trigger) => {
            seen.push({ operation: op, input, trigger: trigger.id });
            return bind(op, input, trigger);
          },
        }),
  };
  const store = makeMemoryStore();
  const worker = makeMockAgentDriver({
    id: "worker",
    output: "done",
    operationCalls: [
      { callId: "c1", integrationId: "chat", operation, input: { text: "hi" } },
    ],
  });
  const app = createOpenMatter({
    store,
    integrations: { chat },
    agents: { worker: worker.driver },
  });
  app.on("chat.mention", (work) =>
    Effect.gen(function* () {
      const context = yield* work.context.project({
        scopeId: "s",
        workThreadId: "w",
        items: [work.context.event()],
        grants: ["chat.reply", "chat.react"],
      });
      yield* work
        .agent("worker")
        .session({ scopeId: "s", workThreadId: "w", privacyPartition: "p" })
        .turn({ context, allow: ["chat.reply", "chat.react"] });
      return work.react.none();
    }),
  );
  await app.accept(ask);
  return {
    delivered,
    seen,
    result: worker.callbackResponses()[0]!
      .result as unknown as OperationCallResult,
    snapshot: await Effect.runPromise(store.inspect),
  };
};

describe("binding tool input to the Turn's trigger", () => {
  it("delivers and records the bound input, and passes the trigger", async () => {
    const t = await run((_op, input, trigger) => ({
      input: { to: trigger.source.messageId!, ...(input as object) },
    }));
    expect(t.seen).toEqual([
      { operation: "reply", input: { text: "hi" }, trigger: "ask" },
    ]);
    expect(t.delivered[0]!.input).toEqual({ to: "m-ask", text: "hi" });
    expect(t.snapshot.operationCalls[0]!.input).toEqual({
      to: "m-ask",
      text: "hi",
    });
    expect(t.result.status).toBe("delivered");
  });

  it("refuses a call the integration cannot bind, without delivering", async () => {
    const refused = await run(() => ({ refused: "No target" }));
    expect(refused.result).toEqual({ status: "refused", reason: "No target" });
    expect(refused.delivered).toEqual([]);

    const throws = await run(() => {
      throw new Error("bug");
    });
    expect(throws.result).toEqual({
      status: "refused",
      reason: "The integration could not bind the call's input",
    });

    const notJson = await run(() => ({
      input: { at: new Date() } as unknown as JsonValue,
    }));
    expect(notJson.result).toEqual({
      status: "refused",
      reason: "The integration bound a non-JSON input",
    });
    expect(notJson.delivered).toEqual([]);
  });

  it("binds only operations that are tools, and only allowed ones", async () => {
    const notATool = await run(
      () => ({ refused: "should not be called" }),
      "react",
    );
    expect(notATool.seen).toEqual([]);
    expect(notATool.result.status).toBe("delivered");

    const unbound = await run(undefined);
    expect(unbound.delivered[0]!.input).toEqual({ text: "hi" });
  });
});

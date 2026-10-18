import { describe, expect, it } from "vitest";
import { makeMockAgentDriver } from "@openma/matter-agent-mock";
import type { OperationCallResult, WorkEvent } from "@openma/matter";
import type { WorkIntegration } from "@openma/matter/integration";
import { createOpenMatter } from "@openma/matter/runtime";
import { makeMemoryStore } from "@openma/matter-store-memory";
import {
  FRESHNESS_PRESETS,
  defineLoop,
  freshnessField,
  freshnessPolicy,
  loopObserves,
  resolveLoopConfig,
} from "@openma/matter-loop";
import { Effect } from "effect";

const event = (
  id: string,
  type: string,
  sender = "alice",
  app = false,
): WorkEvent => ({
  schemaVersion: "0.1",
  id,
  type,
  occurredAt: "2026-08-20T08:00:00.000Z",
  receivedAt: "2026-08-20T08:00:01.000Z",
  idempotencyKey: `chat:${id}`,
  source: { provider: "chat", authority: "workspace-1", conversationId: "r1" },
  payload: { sender, app },
});

const chat: WorkIntegration = {
  manifest: {
    id: "chat",
    displayName: "Chat",
    events: ["chat.mention", "chat.message"],
    operations: ["reply"],
    tools: {
      reply: {
        description: "Reply",
        inputSchema: { type: "object" },
        freshness: "best-effort",
      },
    },
  },
  ingest: () => Effect.succeed([]),
  deliver: () => Effect.succeed({}),
  observe: (e) => {
    const p = e.payload as { sender: string; app: boolean };
    return {
      conversationId: "r1",
      kind: e.type === "chat.mention" ? "mention" : "message",
      threadId: "t1",
      messageId: e.id,
      sender: { id: p.sender, kind: p.app ? "app" : "human" },
    };
  },
};

/** A template that observes messages and replies only through the tool. */
const template = (observes: boolean) =>
  defineLoop(
    {
      id: "chat-answer",
      spec: {
        sources: ["chat.mention"],
        ...(observes ? { observes: ["chat.message"] } : {}),
      },
      configSchema: {
        type: "object",
        properties: { freshness: freshnessField() },
      },
    },
    (app) =>
      app.on("chat.mention", async (work) => {
        if (work.event.id !== "ask") return work.react.none();
        const context = await work.context.project({
          scopeId: "s",
          workThreadId: "w",
          items: [work.context.event()],
          grants: ["chat.reply"],
        });
        await work
          .agent("worker")
          .session({ scopeId: "s", workThreadId: "w", privacyPartition: "p" })
          .turn({
            context,
            allow: ["chat.reply"],
            freshness: freshnessPolicy(work.config.freshness),
          });
        return work.react.none();
      }),
  );

const answer = async (opts: {
  readonly observes: boolean;
  readonly freshness?: string;
  readonly during: readonly WorkEvent[];
}) => {
  const store = makeMemoryStore();
  const worker = makeMockAgentDriver({
    id: "worker",
    output: "done",
    operationCalls: [
      {
        callId: "c1",
        integrationId: "chat",
        operation: "reply",
        input: { text: "answer" },
      },
    ],
    beforeEvents: async () => {
      for (const e of opts.during) await app.accept(e);
    },
  });
  const app = createOpenMatter({
    store,
    integrations: { chat },
    agents: { worker: worker.driver },
  });
  app.loop(
    template(opts.observes),
    opts.freshness === undefined ? {} : { freshness: opts.freshness },
  );
  await app.accept(event("ask", "chat.mention"));
  return { app, store, worker };
};

describe("Loop observes and freshness", () => {
  it("reads spec.observes and rejects a malformed one", () => {
    expect(loopObserves(template(true).definition)).toEqual(["chat.message"]);
    expect(loopObserves(template(false).definition)).toEqual([]);
    expect(loopObserves({})).toEqual([]);
    expect(() =>
      defineLoop({ id: "bad", spec: { observes: "chat.message" } }, () => {}),
    ).toThrow("spec.observes must be a list of event types");
    expect(() =>
      defineLoop({ id: "bad", spec: { observes: [""] } }, () => {}),
    ).toThrow("spec.observes must be a list of event types");
  });

  it("offers the presets as one config field with a thread default", () => {
    const schema = {
      type: "object" as const,
      properties: { freshness: freshnessField() },
    };
    expect(resolveLoopConfig(schema, {})).toEqual({
      ok: true,
      config: { freshness: "thread" },
    });
    expect(resolveLoopConfig(schema, { freshness: "sometimes" }).ok).toBe(
      false,
    );
    expect(freshnessField()["x-oma-widget"]).toBe("freshness");
    expect(freshnessPolicy("conversation")).toEqual(
      FRESHNESS_PRESETS.conversation,
    );
    expect(freshnessPolicy("toString")).toEqual(FRESHNESS_PRESETS.thread);
    expect(freshnessPolicy(undefined)).toEqual(FRESHNESS_PRESETS.thread);
  });

  it("records observed events for an installed guest Loop and checks its reply", async () => {
    const t = await answer({
      observes: true,
      during: [event("fix", "chat.message", "alice")],
    });
    const snapshot = await Effect.runPromise(t.store.inspect);
    expect(snapshot.conversationEntries.map((e) => e.eventId)).toEqual([
      "ask",
      "fix",
    ]);
    expect(
      (t.worker.callbackResponses()[0]!.result as OperationCallResult).status,
    ).toBe("conflict");

    const off = await answer({
      observes: true,
      freshness: "off",
      during: [event("fix", "chat.message", "alice")],
    });
    expect(
      (off.worker.callbackResponses()[0]!.result as OperationCallResult).status,
    ).toBe("delivered");
  });

  it("does not record events a Loop does not observe", async () => {
    const t = await answer({ observes: false, during: [] });
    await t.app.accept(event("later", "chat.message"));
    const snapshot = await Effect.runPromise(t.store.inspect);
    expect(snapshot.conversationEntries.map((e) => e.eventId)).toEqual(["ask"]);
  });

  it("stores the configured preset on the Turn", async () => {
    const t = await answer({
      observes: true,
      freshness: "thread_requester",
      during: [],
    });
    const snapshot = await Effect.runPromise(t.store.inspect);
    expect(snapshot.turns[0]!.freshness).toEqual(
      FRESHNESS_PRESETS.thread_requester,
    );
  });
});

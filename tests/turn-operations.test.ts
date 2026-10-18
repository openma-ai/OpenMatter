import { describe, expect, it } from "vitest";
import {
  makeMockAgentDriver,
  type MockOperationCall,
} from "@openma/matter-agent-mock";
import type { WorkEffect, WorkEvent } from "@openma/matter";
import { OPERATION_CALL_METHOD } from "@openma/matter/agent";
import {
  IntegrationError,
  type WorkIntegration,
} from "@openma/matter/integration";
import { createOpenMatter } from "@openma/matter/runtime";
import { makeMemoryStore } from "@openma/matter-store-memory";
import { StoreError } from "@openma/matter/store";
import { Effect } from "effect";

const messageEvent = (id: string): WorkEvent => ({
  schemaVersion: "0.1",
  id,
  type: "chat.message.received",
  occurredAt: "2026-08-20T08:00:00.000Z",
  receivedAt: "2026-08-20T08:00:01.000Z",
  idempotencyKey: `chat:${id}`,
  source: {
    provider: "chat",
    authority: "workspace-1",
    conversationId: "channel-1",
    messageId: id,
  },
  payload: { text: "hello" },
});

type Outcome =
  | { readonly kind: "ok" }
  | { readonly kind: "not-applied"; readonly retryable: boolean }
  | { readonly kind: "unknown" }
  | { readonly kind: "defect" };

const makeChat = (outcome: Outcome = { kind: "ok" }) => {
  const delivered: WorkEffect[] = [];
  const integration: WorkIntegration = {
    manifest: {
      id: "chat",
      displayName: "Chat",
      events: ["chat.message.received"],
      operations: ["reply", "react"],
      tools: {
        reply: {
          description: "Reply to the message",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      },
    },
    ingest: () => Effect.succeed([]),
    deliver: (effect) => {
      delivered.push(effect);
      switch (outcome.kind) {
        case "ok":
          return Effect.succeed({
            providerReceipt: { messageId: `m${delivered.length}` },
          });
        case "not-applied":
          return Effect.fail(
            new IntegrationError({
              message: "Rate limited",
              retryable: outcome.retryable,
              effectState: "not-applied",
            }),
          );
        case "unknown":
          return Effect.fail(
            new IntegrationError({ message: "Timed out", retryable: true }),
          );
        case "defect":
          return Effect.die(new Error("boom"));
      }
    },
  };
  return { integration, delivered };
};

const run = async (opts: {
  readonly calls: readonly MockOperationCall[];
  readonly allow?: readonly string[];
  readonly outcome?: Outcome;
  readonly operations?: boolean;
}) => {
  const store = makeMemoryStore();
  const chat = makeChat(opts.outcome);
  const worker = makeMockAgentDriver({
    id: "worker",
    output: "done",
    operationCalls: opts.calls,
    ...(opts.operations === undefined ? {} : { operations: opts.operations }),
  });
  const app = createOpenMatter({
    store,
    integrations: { chat: chat.integration },
    agents: { worker: worker.driver },
  });
  const allow = opts.allow ?? ["chat.reply"];
  let turnId = "";
  app.on("chat.message.received", (work) =>
    Effect.gen(function* () {
      const context = yield* work.context.project({
        scopeId: "scope-1",
        workThreadId: "thread-1",
        items: [work.context.event()],
        grants: [...allow],
      });
      const turn = yield* work
        .agent("worker")
        .session({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          privacyPartition: "team",
        })
        .turn({ context, allow });
      turnId = turn.turn.id;
      return work.react.none();
    }),
  );
  const accepted = app.accept(messageEvent("message-1"));
  return { accepted, store, chat, worker, turnId: () => turnId };
};

const reply = (callId: string, text = "hi"): MockOperationCall => ({
  callId,
  integrationId: "chat",
  operation: "reply",
  input: { text },
});

describe("operations an Agent calls during its Turn", () => {
  it("delivers an allowed call once and returns the receipt to the Agent", async () => {
    const t = await run({ calls: [reply("c1")] });
    await t.accepted;

    expect(t.chat.delivered).toEqual([
      {
        schemaVersion: "0.1",
        id: `${t.turnId()}:call:c1`,
        eventId: "message-1",
        integrationId: "chat",
        operation: "reply",
        idempotencyKey: `${t.turnId()}:call:c1`,
        input: { text: "hi" },
      },
    ]);
    expect(t.worker.callbackResponses()).toEqual([
      {
        callbackId: "c1",
        result: { status: "delivered", receipt: { messageId: "m1" } },
      },
    ]);
    const snapshot = await Effect.runPromise(t.store.inspect);
    expect(snapshot.operationCalls).toEqual([
      expect.objectContaining({
        turnId: t.turnId(),
        callId: "c1",
        integrationId: "chat",
        operation: "reply",
        state: "completed",
        result: { status: "delivered", receipt: { messageId: "m1" } },
      }),
    ]);
    // The request is part of the durable Turn record.
    expect(
      snapshot.agentEvents.filter(
        (e) =>
          e.type === "callback.requested" &&
          (e.data as { method?: string }).method === OPERATION_CALL_METHOD,
      ),
    ).toHaveLength(1);
  });

  it("offers the allowed operations that have tool descriptors", async () => {
    const t = await run({ calls: [], allow: ["chat.reply", "chat.react"] });
    await t.accepted;
    expect(t.worker.turnInputs()[0]!.tools).toEqual([
      {
        name: "chat.reply",
        integrationId: "chat",
        operation: "reply",
        description: "Reply to the message",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
    ]);
  });

  it("answers a repeated callback id from the stored result without delivering again", async () => {
    const t = await run({ calls: [reply("c1"), reply("c1")] });
    await t.accepted;
    expect(t.chat.delivered).toHaveLength(1);
    expect(t.worker.callbackResponses().map((r) => r.result)).toEqual([
      { status: "delivered", receipt: { messageId: "m1" } },
      { status: "delivered", receipt: { messageId: "m1" } },
    ]);
  });

  it("rejects a reused callback id with different content", async () => {
    const t = await run({ calls: [reply("c1", "a"), reply("c1", "b")] });
    await expect(t.accepted).rejects.toThrow(
      "Operation call content changed for reused callback id: c1",
    );
    expect(t.chat.delivered).toHaveLength(1);
  });

  it("refuses an operation the Turn does not allow, or one the integration does not declare", async () => {
    const t = await run({
      calls: [
        { callId: "c1", integrationId: "chat", operation: "react", input: {} },
        { callId: "c2", integrationId: "chat", operation: "delete", input: {} },
        { callId: "c3", integrationId: "mail", operation: "send", input: {} },
      ],
      allow: ["chat.reply", "chat.delete"],
    });
    await t.accepted;
    expect(t.chat.delivered).toEqual([]);
    expect(t.worker.callbackResponses()).toEqual([
      {
        callbackId: "c1",
        result: {
          status: "refused",
          reason: "Operation is not allowed for this Turn: chat.react",
        },
      },
      {
        callbackId: "c2",
        result: { status: "refused", reason: "Unknown operation: chat.delete" },
      },
      {
        callbackId: "c3",
        result: {
          status: "refused",
          reason: "Operation is not allowed for this Turn: mail.send",
        },
      },
    ]);
  });

  it("reports a known-not-applied failure as failed, and anything else as uncertain", async () => {
    const notApplied = await run({
      calls: [reply("c1")],
      outcome: { kind: "not-applied", retryable: true },
    });
    await notApplied.accepted;
    expect(notApplied.worker.callbackResponses()[0]!.result).toEqual({
      status: "failed",
      reason: "Rate limited",
      retryable: true,
    });

    const unknown = await run({
      calls: [reply("c1")],
      outcome: { kind: "unknown" },
    });
    await unknown.accepted;
    expect(unknown.worker.callbackResponses()[0]!.result).toEqual({
      status: "uncertain",
      reason: "Timed out",
    });

    const defect = await run({
      calls: [reply("c1")],
      outcome: { kind: "defect" },
    });
    await defect.accepted;
    expect(defect.worker.callbackResponses()[0]!.result).toEqual({
      status: "uncertain",
      reason: "The integration failed while delivering the call",
    });
    expect(defect.chat.delivered).toHaveLength(1);
  });

  it("reports a call interrupted after delivery as uncertain on replay, without delivering again", async () => {
    let now = Date.parse("2026-08-20T08:00:00.000Z");
    const clock = () => new Date(now).toISOString();
    const base = makeMemoryStore({ clock });
    let crash = true;
    // The process dies after the provider accepted the call and before the
    // outcome was recorded.
    const store = {
      ...base,
      completeOperationCall: (
        ...args: Parameters<typeof base.completeOperationCall>
      ) => {
        if (crash) {
          crash = false;
          return Effect.fail(new StoreError({ message: "crash" }));
        }
        return base.completeOperationCall(...args);
      },
    };
    const chat = makeChat();
    const worker = makeMockAgentDriver({
      id: "worker",
      output: "done",
      operationCalls: [reply("c1")],
    });
    const app = createOpenMatter({
      store,
      integrations: { chat: chat.integration },
      agents: { worker: worker.driver },
      clock,
      eventLeaseMs: 1_000,
      sessionLeaseMs: 1_000,
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [],
          grants: ["chat.reply"],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context, allow: ["chat.reply"] });
        return work.react.none();
      }),
    );

    await expect(app.accept(messageEvent("message-1"))).rejects.toThrow(
      "crash",
    );
    expect(chat.delivered).toHaveLength(1);
    expect(worker.callbackResponses()).toEqual([]);

    now += 5_000; // the leases expire; the Event is replayed
    await app.accept(messageEvent("message-1"));

    expect(chat.delivered).toHaveLength(1);
    expect(worker.callbackResponses()).toEqual([
      {
        callbackId: "c1",
        result: {
          status: "uncertain",
          reason:
            "The outcome of this call was not recorded before the Turn was interrupted; check before calling again",
        },
      },
    ]);
  });

  it("fails the Turn when a driver reports a call it cannot answer", async () => {
    const t = await run({ calls: [reply("c1")], operations: false });
    await expect(t.accepted).rejects.toThrow(
      "Agent called an operation but its driver does not support operation calls",
    );
    expect(t.chat.delivered).toEqual([]);
  });
});

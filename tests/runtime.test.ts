import { describe, expect, it } from "vitest";
import { makeMockAgentDriver } from "@openmatter/agent-mock";
import {
  AgentDriverError,
  AgentSessionUnavailableError,
  createOpenMAEvent,
  isPermissionRequestEvent,
  type OpenMAEvent,
} from "@openmatter/agent";
import { makeMockIntegration } from "@openmatter/integration-mock";
import {
  IntegrationError,
  type WorkIntegration,
} from "@openmatter/integration";
import { createOpenMatter } from "@openmatter/runtime";
import { makeMemoryStore } from "@openmatter/store-memory";
import { StoreError } from "@openmatter/store";
import type {
  ContextProjection,
  WorkEffect,
  WorkEvent,
} from "@openmatter/core";
import { Deferred, Effect, Fiber, Stream } from "effect";

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
  payload: {
    text: "hello",
  },
});

describe("OpenMatter runtime", () => {
  it("turns an accepted work event into an agent-backed reaction and delivered effect", async () => {
    const store = makeMemoryStore();
    const chat = makeMockIntegration({ id: "chat" });
    const worker = makeMockAgentDriver({
      id: "worker",
      output: "Hello from the agent",
    });
    const app = createOpenMatter({
      store,
      integrations: { chat: chat.integration },
      agents: { worker: worker.driver },
    });

    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
          grants: ["chat.message.reply"],
        });
        const turn = yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context, allow: ["chat.message.reply"] });

        const effect = yield* work.effect(context, {
          integrationId: "chat",
          operation: "message.reply",
          input: { text: turn.output ?? null },
        });
        return work.react.effects([effect]);
      }),
    );

    const receipt = await app.accept(messageEvent("message-1"));

    expect(receipt.reaction.status).toBe("completed");
    expect(receipt.reaction.effects).toHaveLength(1);
    expect(receipt.deliveries).toEqual([
      expect.objectContaining({
        integrationId: "chat",
        operation: "message.reply",
        status: "delivered",
      }),
    ]);
    expect(chat.delivered()).toEqual([
      expect.objectContaining({
        input: { text: "Hello from the agent" },
      }),
    ]);
  });

  it("projects a chunk-only canonical Agent message as one complete output", async () => {
    const store = makeMemoryStore();
    const worker = makeMockAgentDriver({ id: "worker", output: "unused" });
    const driver = {
      ...worker.driver,
      turn: (input: Parameters<typeof worker.driver.turn>[0]) =>
        Stream.make(
          createOpenMAEvent({
            event_id: `${input.turnId}:chunk-1`,
            session_id: input.sessionId,
            turn_id: input.turnId,
            seq: 1,
            type: "agent.message_chunk",
            occurred_at: "2026-08-20T08:00:00.000Z",
            source: { kind: "harness", harness: "acp" },
            data: { text: "Hel", message_id: "message-1" },
          }),
          createOpenMAEvent({
            event_id: `${input.turnId}:chunk-2`,
            session_id: input.sessionId,
            turn_id: input.turnId,
            seq: 2,
            type: "agent.message_chunk",
            occurred_at: "2026-08-20T08:00:01.000Z",
            source: { kind: "harness", harness: "acp" },
            data: { text: "lo", message_id: "message-1" },
          }),
          createOpenMAEvent({
            event_id: `${input.turnId}:terminal`,
            session_id: input.sessionId,
            turn_id: input.turnId,
            seq: 3,
            type: "turn.completed",
            occurred_at: "2026-08-20T08:00:02.000Z",
            source: { kind: "harness", harness: "acp" },
            data: {},
          }),
        ),
    };
    let output: unknown;
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: driver },
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        output = (yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context })).output;
        return work.react.none();
      }),
    );

    await app.accept(messageEvent("message-chunks"));

    expect(output).toBe("Hello");
  });

  it("records an explicit null reaction when a handler intentionally does nothing", async () => {
    const store = makeMemoryStore();
    const chat = makeMockIntegration({ id: "chat" });
    const app = createOpenMatter({
      store,
      integrations: { chat: chat.integration },
      agents: {},
    });

    app.on("chat.message.received", async (work) =>
      work.react.none("No response needed"),
    );

    const receipt = await app.accept(messageEvent("message-2"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        eventId: "message-2",
        status: "completed",
        effects: [],
        reason: "No response needed",
      }),
    );
    expect(receipt.deliveries).toEqual([]);
    expect(chat.delivered()).toEqual([]);
  });

  it("records a null reaction when no handler subscribes to an event", async () => {
    const store = makeMemoryStore();
    const chat = makeMockIntegration({ id: "chat" });
    const app = createOpenMatter({
      store,
      integrations: { chat: chat.integration },
      agents: {},
    });

    const receipt = await app.accept(messageEvent("message-unhandled"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        eventId: "message-unhandled",
        status: "completed",
        effects: [],
        reason: "No handler registered for chat.message.received",
      }),
    );
    expect(receipt.deliveries).toEqual([]);
  });

  it("returns the stored terminal receipt without delivering effects twice", async () => {
    const store = makeMemoryStore();
    const chat = makeMockIntegration({ id: "chat" });
    const app = createOpenMatter({
      store,
      integrations: { chat: chat.integration },
      agents: {},
    });

    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
          grants: ["chat.message.react"],
        });
        const effect = yield* work.effect(context, {
          integrationId: "chat",
          operation: "message.react",
          input: { emoji: "eyes" },
        });
        return work.react.effects([effect]);
      }),
    );

    const event = messageEvent("message-3");
    const first = await app.accept(event);
    const duplicate = await app.accept(event);

    expect(duplicate.reaction.id).toBe(first.reaction.id);
    expect(duplicate.duplicate).toBe(true);
    expect(chat.delivered()).toHaveLength(1);
  });

  it("reuses one agent session for turns with the same binding", async () => {
    const store = makeMemoryStore();
    const worker = makeMockAgentDriver({ id: "worker", output: "ok" });
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: worker.driver },
    });

    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    await app.accept(messageEvent("message-4"));
    await app.accept(messageEvent("message-5"));

    const snapshot = await Effect.runPromise(store.inspect);
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.agentEvents).toHaveLength(4);
    expect(snapshot.sessions[0]).toEqual(
      expect.objectContaining({
        agentId: "worker",
        authority: "workspace-1",
        scopeId: "scope-1",
        workThreadId: "thread-1",
        privacyPartition: "team",
        state: "open",
      }),
    );
  });

  it("persists a failed terminal reaction when application code fails", async () => {
    const store = makeMemoryStore();
    const app = createOpenMatter({ store, integrations: {}, agents: {} });

    app.on("chat.message.received", () =>
      Effect.fail(new Error("handler exploded")),
    );

    const receipt = await app.accept(messageEvent("message-6"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        eventId: "message-6",
        status: "failed",
        effects: [],
        reason: "handler exploded",
      }),
    );
  });

  it("can reconstruct a serverless application around shared durable ports", async () => {
    const store = makeMemoryStore();
    const chat = makeMockIntegration({ id: "chat" });
    const buildApp = () => {
      const app = createOpenMatter({
        store,
        integrations: { chat: chat.integration },
        agents: {},
      });
      app.on("chat.message.received", (work) =>
        Effect.gen(function* () {
          const context = yield* work.context.project({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            items: [work.context.event()],
            grants: ["chat.message.reply"],
          });
          const effect = yield* work.effect(context, {
            integrationId: "chat",
            operation: "message.reply",
            input: { text: "ack" },
          });
          return work.react.effects([effect]);
        }),
      );
      return app;
    };

    const event = messageEvent("message-7");
    const first = await buildApp().accept(event);
    const replay = await buildApp().accept(event);

    expect(replay.reaction.id).toBe(first.reaction.id);
    expect(replay.duplicate).toBe(true);
    expect(chat.delivered()).toHaveLength(1);
  });

  it("consumes a finite long-lived source through the same accept pipeline", async () => {
    const store = makeMemoryStore();
    const app = createOpenMatter({ store, integrations: {}, agents: {} });
    app.on("chat.message.received", async (work) => work.react.none());

    async function* events() {
      yield messageEvent("message-8");
      yield messageEvent("message-9");
    }

    const summary = await app.consume(events());

    expect(summary).toEqual({ processed: 2, failed: 0, duplicates: 0 });
    expect((await Effect.runPromise(store.inspect)).reactions).toHaveLength(2);
  });

  it("persists an authorized context projection with provenance", async () => {
    const store = makeMemoryStore();
    const app = createOpenMatter({ store, integrations: {}, agents: {} });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
          grants: ["chat.message.reply"],
        });
        return work.react.none();
      }),
    );

    await app.accept(messageEvent("message-10"));

    const snapshot = await Effect.runPromise(store.inspect);
    expect(snapshot.contexts).toHaveLength(1);
    expect(snapshot.contexts[0]).toEqual(
      expect.objectContaining({
        scopeId: "scope-1",
        workThreadId: "thread-1",
        triggerEventId: "message-10",
        grants: ["chat.message.reply"],
        items: [
          expect.objectContaining({
            id: "message-10",
            kind: "event",
            provenance: [
              {
                sourceType: "work-event",
                sourceId: "message-10",
                integrationId: "chat",
              },
            ],
          }),
        ],
      }),
    );
    expect(snapshot.contexts[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reclaims a retryable effect failure through the outbox recovery entry", async () => {
    let now = "2026-08-20T08:00:00.000Z";
    const store = makeMemoryStore();
    const chat = makeMockIntegration({ id: "chat", failuresBeforeSuccess: 1 });
    const app = createOpenMatter({
      store,
      integrations: { chat: chat.integration },
      agents: {},
      clock: () => now,
      effectRetryDelayMs: 1_000,
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
          grants: ["chat.message.reply"],
        });
        const effect = yield* work.effect(context, {
          integrationId: "chat",
          operation: "message.reply",
          input: { text: "retry me" },
        });
        return work.react.effects([effect]);
      }),
    );

    const first = await app.accept(messageEvent("message-11"));
    expect(first.deliveries).toEqual([
      expect.objectContaining({
        status: "retryable-failed",
        attempt: 1,
        nextRetryAt: "2026-08-20T08:00:01.000Z",
      }),
    ]);

    now = "2026-08-20T08:00:02.000Z";
    const recovered = await app.recoverEffects();

    expect(recovered).toEqual([
      expect.objectContaining({ status: "delivered", attempt: 2 }),
    ]);
    expect((await Effect.runPromise(store.inspect)).deliveries).toEqual([
      expect.objectContaining({ status: "delivered", attempt: 2 }),
    ]);
  });

  it("honors a provider's absolute retry time for outbox delivery", async () => {
    const store = makeMemoryStore();
    const chat: WorkIntegration = {
      manifest: {
        id: "chat",
        displayName: "Chat",
        events: [],
        operations: ["message.reply"],
      },
      ingest: () => Effect.succeed([]),
      deliver: () =>
        Effect.fail(
          new IntegrationError({
            message: "provider rate limit",
            retryable: true,
            retryAt: "2026-08-20T08:01:00.000Z",
          }),
        ),
    };
    const app = createOpenMatter({
      store,
      integrations: { chat },
      agents: {},
      clock: () => "2026-08-20T08:00:00.000Z",
      effectRetryDelayMs: 1_000,
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
          grants: ["chat.message.reply"],
        });
        const effect = yield* work.effect(context, {
          integrationId: "chat",
          operation: "message.reply",
          input: { text: "retry later" },
        });
        return work.react.effects([effect]);
      }),
    );

    const receipt = await app.accept(messageEvent("provider-retry-at"));

    expect(receipt.deliveries).toEqual([
      expect.objectContaining({
        status: "retryable-failed",
        nextRetryAt: "2026-08-20T08:01:00.000Z",
      }),
    ]);
  });

  it("rejects a forged effect that was not authorized by the runtime", async () => {
    const store = makeMemoryStore();
    const chat = makeMockIntegration({ id: "chat" });
    const app = createOpenMatter({
      store,
      integrations: { chat: chat.integration },
      agents: {},
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
          grants: ["chat.message.reply"],
        });
        return work.react.effects([
          {
            schemaVersion: "0.1",
            id: "forged-effect",
            eventId: work.event.id,
            integrationId: "chat",
            operation: "message.delete",
            idempotencyKey: "forged",
            input: {},
          },
        ]);
      }),
    );

    const receipt = await app.accept(messageEvent("message-12"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        status: "failed",
        effects: [],
        reason: expect.stringContaining("authorized"),
      }),
    );
    expect(chat.delivered()).toEqual([]);
  });

  it("requires turn permissions to be a subset of context grants", async () => {
    const store = makeMemoryStore();
    const worker = makeMockAgentDriver({ id: "worker", output: "ok" });
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: worker.driver },
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
          grants: ["chat.read"],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context, allow: ["chat.admin"] });
        return work.react.none();
      }),
    );

    const receipt = await app.accept(messageEvent("message-13"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        status: "failed",
        reason: expect.stringContaining("grant"),
      }),
    );
    expect((await Effect.runPromise(store.inspect)).turns).toEqual([]);
  });

  it("rejects grant escalation by mutating a projected context before an effect", async () => {
    const store = makeMemoryStore();
    const chat = makeMockIntegration({ id: "chat" });
    const app = createOpenMatter({
      store,
      integrations: { chat: chat.integration },
      agents: {},
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        (context.grants as string[]).push("chat.message.reply");
        const effect = yield* work.effect(context, {
          integrationId: "chat",
          operation: "message.reply",
          input: { text: "escalated" },
        });
        return work.react.effects([effect]);
      }),
    );

    const receipt = await app.accept(messageEvent("message-32"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        status: "failed",
        effects: [],
        reason: expect.stringContaining("ContextProjection"),
      }),
    );
    expect(chat.delivered()).toEqual([]);
    expect(
      (await Effect.runPromise(store.inspect)).contexts[0]?.grants,
    ).toEqual([]);
  });

  it("rejects a mutated projected context before an Agent turn", async () => {
    const store = makeMemoryStore();
    const worker = makeMockAgentDriver({ id: "worker", output: "unused" });
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: worker.driver },
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        (context.grants as string[]).push("chat.read");
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context, allow: ["chat.read"] });
        return work.react.none();
      }),
    );

    const receipt = await app.accept(messageEvent("message-33"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        status: "failed",
        effects: [],
        reason: expect.stringContaining("ContextProjection"),
      }),
    );
    expect((await Effect.runPromise(store.inspect)).turns).toEqual([]);
  });

  it("rejects an agent stream that ends without a terminal event", async () => {
    const store = makeMemoryStore();
    const worker = makeMockAgentDriver({
      id: "worker",
      output: "partial",
      omitTerminal: true,
    });
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: worker.driver },
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    await expect(app.accept(messageEvent("message-14"))).rejects.toThrow(
      "terminal",
    );
    const snapshot = await Effect.runPromise(store.inspect);
    expect(snapshot.reactions).toEqual([]);
    expect(snapshot.agentEvents).toHaveLength(1);
    expect(snapshot.turns).toEqual([
      expect.objectContaining({ state: "failed" }),
    ]);
  });

  it("does not make an invalid post-terminal stream durable as success", async () => {
    let now = "2026-08-20T08:00:00.000Z";
    let turnCalls = 0;
    const store = makeMemoryStore({ clock: () => now });
    const worker = makeMockAgentDriver({ id: "worker", output: "unused" });
    const driver = {
      ...worker.driver,
      turn: (input: Parameters<typeof worker.driver.turn>[0]) => {
        turnCalls += 1;
        const events: readonly OpenMAEvent[] = [
          createOpenMAEvent({
            event_id: `${input.turnId}:output`,
            session_id: input.sessionId,
            turn_id: input.turnId,
            seq: 1,
            type: "agent.message",
            occurred_at: now,
            source: { kind: "harness", harness: "test" },
            data: { text: "before terminal" },
          }),
          createOpenMAEvent({
            event_id: `${input.turnId}:terminal`,
            session_id: input.sessionId,
            turn_id: input.turnId,
            seq: 2,
            type: "turn.completed",
            occurred_at: now,
            source: { kind: "harness", harness: "test" },
            data: {},
          }),
          createOpenMAEvent({
            event_id: `${input.turnId}:illegal-extra`,
            session_id: input.sessionId,
            turn_id: input.turnId,
            seq: 3,
            type: "agent.message",
            occurred_at: now,
            source: { kind: "harness", harness: "test" },
            data: { text: "after terminal" },
          }),
        ];
        return Stream.fromIterable(
          events.filter(
            (agentEvent) => (agentEvent.seq ?? 0) > input.afterSequence,
          ),
        );
      },
    };
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: driver },
      eventLeaseMs: 30,
      clock: () => now,
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    const event = messageEvent("message-invalid-post-terminal");
    await expect(app.accept(event)).rejects.toThrow("after its terminal");
    now = "2026-08-20T08:01:00.000Z";
    await expect(app.accept(event)).rejects.toThrow("after its terminal");

    expect(turnCalls).toBe(2);
    const snapshot = await Effect.runPromise(store.inspect);
    expect(snapshot.reactions).toEqual([]);
    expect(snapshot.agentEvents.map((agentEvent) => agentEvent.type)).toEqual([
      "agent.message",
    ]);
  });

  it("snapshots a mutable custom Driver event before the durable async boundary", async () => {
    const memory = makeMemoryStore();
    const store = {
      ...memory,
      appendAgentEvent: (...args: Parameters<typeof memory.appendAgentEvent>) =>
        Effect.sleep("20 millis").pipe(
          Effect.zipRight(memory.appendAgentEvent(...args)),
        ),
    };
    const worker = makeMockAgentDriver({ id: "worker", output: "unused" });
    const driver = {
      ...worker.driver,
      turn: (input: Parameters<typeof worker.driver.turn>[0]) => {
        const mutable = {
          schema_version: "oma.event.v1",
          event_id: `${input.turnId}:output`,
          session_id: input.sessionId,
          turn_id: input.turnId,
          seq: 1,
          type: "agent.message",
          occurred_at: "2026-08-20T08:00:00.000Z",
          source: { kind: "harness", harness: "custom" },
          data: { text: "authorized" },
        } as unknown as OpenMAEvent;
        setTimeout(() => {
          (mutable.data as { text: string }).text = "mutated";
        }, 0);
        return Stream.make(
          mutable,
          createOpenMAEvent({
            event_id: `${input.turnId}:terminal`,
            session_id: input.sessionId,
            turn_id: input.turnId,
            seq: 2,
            type: "turn.completed",
            occurred_at: "2026-08-20T08:00:01.000Z",
            source: { kind: "harness", harness: "custom" },
            data: {},
          }),
        );
      },
    };
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: driver },
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    const receipt = await app.accept(messageEvent("message-agent-snapshot"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({ status: "completed" }),
    );
    expect((await Effect.runPromise(memory.inspect)).agentEvents[0]).toEqual(
      expect.objectContaining({ data: { text: "authorized" } }),
    );
  });

  it("persists cancellation while preserving Effect interruption", async () => {
    const store = makeMemoryStore();
    const started = await Effect.runPromise(Deferred.make<void>());
    const app = createOpenMatter({ store, integrations: {}, agents: {} });
    app.on("chat.message.received", () =>
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }),
    );

    const fiber = Effect.runFork(app.acceptEffect(messageEvent("message-15")));
    await Effect.runPromise(Deferred.await(started));
    const exit = await Effect.runPromise(Fiber.interrupt(fiber));

    expect(exit._tag).toBe("Failure");
    expect((await Effect.runPromise(store.inspect)).reactions).toEqual([
      expect.objectContaining({
        eventId: "message-15",
        status: "cancelled",
        effects: [],
      }),
    ]);
  });

  it("marks an interrupted agent turn as cancelled", async () => {
    const store = makeMemoryStore();
    const worker = makeMockAgentDriver({
      id: "worker",
      output: "unused",
      neverComplete: true,
    });
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: worker.driver },
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    const fiber = Effect.runFork(app.acceptEffect(messageEvent("message-17")));
    while ((await Effect.runPromise(store.inspect)).turns.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect((await Effect.runPromise(store.inspect)).turns).toEqual([
      expect.objectContaining({ state: "cancelled" }),
    ]);
    expect(worker.cancelledTurns()).toHaveLength(1);
  });

  it("does not revive a cancelled Turn when its Reaction commit failed", async () => {
    let now = "2026-08-20T08:00:00.000Z";
    let failCancellationCommit = true;
    let turnCalls = 0;
    const started = await Effect.runPromise(Deferred.make<void>());
    const memory = makeMemoryStore({ clock: () => now });
    const store = {
      ...memory,
      commitTerminalReaction: (
        reaction: Parameters<typeof memory.commitTerminalReaction>[0],
        leaseToken: string,
      ) => {
        if (failCancellationCommit && reaction.status === "cancelled") {
          failCancellationCommit = false;
          return Effect.fail(
            new StoreError({ message: "cancellation commit unavailable" }),
          );
        }
        return memory.commitTerminalReaction(reaction, leaseToken);
      },
    } satisfies typeof memory;
    const worker = makeMockAgentDriver({ id: "worker", output: "duplicate" });
    const driver = {
      ...worker.driver,
      turn: (input: Parameters<typeof worker.driver.turn>[0]) => {
        turnCalls += 1;
        if (turnCalls > 1) return worker.driver.turn(input);
        return Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
          Stream.drain,
          Stream.concat(Stream.never),
        );
      },
    };
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: driver },
      eventLeaseMs: 30,
      clock: () => now,
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    const event = messageEvent("message-cancelled-replay");
    const running = Effect.runFork(app.acceptEffect(event));
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Fiber.interrupt(running));
    expect((await Effect.runPromise(memory.inspect)).turns).toEqual([
      expect.objectContaining({ state: "cancelled" }),
    ]);

    now = "2026-08-20T08:01:00.000Z";
    const replay = await app.accept(event);

    expect(replay.reaction.status).toBe("completed");
    expect(turnCalls).toBe(1);
    expect(
      (await Effect.runPromise(memory.inspect)).agentEvents.map(
        (agentEvent) => agentEvent.type,
      ),
    ).toEqual(["turn.interrupted"]);
  });

  it("treats an agent cancellation as a domain outcome", async () => {
    const store = makeMemoryStore();
    const worker = makeMockAgentDriver({
      id: "worker",
      output: "unused",
      terminalType: "turn.cancelled",
    });
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: worker.driver },
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        const result = yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return {
          status:
            result.outcome === "interrupted" ? "cancelled" : result.outcome,
          effects: [],
          reason: "Agent cancelled the turn",
        };
      }),
    );

    const receipt = await app.accept(messageEvent("message-19"));

    expect(receipt.reaction.status).toBe("cancelled");
    expect((await Effect.runPromise(store.inspect)).turns).toEqual([
      expect.objectContaining({ state: "cancelled" }),
    ]);
  });

  it("answers permission requests while the Agent stream is running", async () => {
    const store = makeMemoryStore();
    const worker = makeMockAgentDriver({
      id: "worker",
      output: "approved",
      permissionRequestId: "permission-1",
    });
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: worker.driver },
      permissionPolicy: ({ context }) => context.grants.includes("chat.read"),
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
          grants: ["chat.read"],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    await app.accept(messageEvent("message-20"));

    expect(worker.permissionResponses()).toEqual([
      { requestId: "permission-1", approved: true },
    ]);
  });

  it("rejects a non-boolean permission policy decision", async () => {
    const store = makeMemoryStore();
    const worker = makeMockAgentDriver({
      id: "worker",
      output: "unused",
      permissionRequestId: "permission-invalid-decision",
    });
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: worker.driver },
      permissionPolicy: () => "yes" as never,
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    await expect(
      app.accept(messageEvent("message-invalid-permission-decision")),
    ).rejects.toThrow("boolean");
    expect(
      (await Effect.runPromise(store.inspect)).permissionDecisions,
    ).toEqual([]);
    expect(worker.permissionResponses()).toEqual([]);
  });

  it("creates a new Session generation when the driver cannot resume", async () => {
    const store = makeMemoryStore();
    const worker = makeMockAgentDriver({
      id: "worker",
      output: "ok",
      resume: false,
    });
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: worker.driver },
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    await app.accept(messageEvent("message-21"));
    await app.accept(messageEvent("message-22"));

    const sessions = (await Effect.runPromise(store.inspect)).sessions;
    expect(worker.createdSessions()).toBe(2);
    expect(sessions).toEqual([
      expect.objectContaining({ generation: 1, state: "closed" }),
      expect.objectContaining({ generation: 2, state: "open" }),
    ]);
    expect(sessions[0]?.id).not.toBe(sessions[1]?.id);
  });

  it("renews an event lease while a long handler is still running", async () => {
    const store = makeMemoryStore();
    const started = await Effect.runPromise(Deferred.make<void>());
    const event = messageEvent("message-18");
    const first = createOpenMatter({
      store,
      integrations: {},
      agents: {},
      runtimeId: "runtime-1",
      eventLeaseMs: 30,
    });
    first.on("chat.message.received", () =>
      Deferred.succeed(started, undefined).pipe(Effect.zipRight(Effect.never)),
    );

    const running = Effect.runFork(first.acceptEffect(event));
    await Effect.runPromise(Deferred.await(started));
    await new Promise((resolve) => setTimeout(resolve, 80));

    const contender = createOpenMatter({
      store,
      integrations: {},
      agents: {},
      runtimeId: "runtime-2",
      eventLeaseMs: 30,
    });
    contender.on("chat.message.received", (work) => work.react.none());

    await expect(contender.accept(event)).rejects.toThrow(
      "already being processed",
    );
    await Effect.runPromise(Fiber.interrupt(running));
  });

  it("rejects non-JSON context values instead of producing a colliding digest", async () => {
    const store = makeMemoryStore();
    const app = createOpenMatter({ store, integrations: {}, agents: {} });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [
            work.context.value({
              kind: "unsupported",
              value: new Map([["key", "value"]]) as never,
              provenance: [
                { sourceType: "application", sourceId: "bad-context" },
              ],
            }),
          ],
        });
        return work.react.none();
      }),
    );

    const receipt = await app.accept(messageEvent("message-16"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        status: "failed",
        reason: expect.stringContaining("serializable"),
      }),
    );
  });

  it("rejects non-JSON WorkEffect input before the outbox boundary", async () => {
    const store = makeMemoryStore();
    const chat = makeMockIntegration({ id: "chat" });
    const app = createOpenMatter({
      store,
      integrations: { chat: chat.integration },
      agents: {},
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
          grants: ["chat.message.reply"],
        });
        const effect = yield* work.effect(context, {
          integrationId: "chat",
          operation: "message.reply",
          input: new Map([["text", "not portable"]]) as never,
        });
        return work.react.effects([effect]);
      }),
    );

    const receipt = await app.accept(messageEvent("message-23"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        status: "failed",
        effects: [],
        reason: expect.stringContaining("portable JSON"),
      }),
    );
    expect(chat.delivered()).toEqual([]);
  });

  it("rejects an authorized WorkEffect whose immutable payload is replaced", async () => {
    const store = makeMemoryStore();
    const chat = makeMockIntegration({ id: "chat" });
    const app = createOpenMatter({
      store,
      integrations: { chat: chat.integration },
      agents: {},
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
          grants: ["chat.message.reply"],
        });
        const authorized = yield* work.effect(context, {
          integrationId: "chat",
          operation: "message.reply",
          input: { text: "authorized" },
        });
        return work.react.effects([
          {
            ...authorized,
            input: new Map([["text", "replaced"]]) as never,
          },
        ]);
      }),
    );

    const receipt = await app.accept(messageEvent("message-27"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        status: "failed",
        effects: [],
        reason: expect.stringContaining("portable terminal"),
      }),
    );
    expect(chat.delivered()).toEqual([]);
  });

  it("detects in-place mutation of an authorized WorkEffect", async () => {
    const store = makeMemoryStore();
    const chat = makeMockIntegration({ id: "chat" });
    const app = createOpenMatter({
      store,
      integrations: { chat: chat.integration },
      agents: {},
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
          grants: ["chat.message.reply"],
        });
        const authorized = yield* work.effect(context, {
          integrationId: "chat",
          operation: "message.reply",
          input: { text: "authorized" },
        });
        (authorized.input as { text: string }).text = "mutated";
        return work.react.effects([authorized]);
      }),
    );

    const receipt = await app.accept(messageEvent("message-30"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        status: "failed",
        effects: [],
        reason: expect.stringContaining("authorized"),
      }),
    );
    expect(chat.delivered()).toEqual([]);
  });

  it("contains an invalid ReactionDraft before terminal persistence", async () => {
    const store = makeMemoryStore();
    const app = createOpenMatter({ store, integrations: {}, agents: {} });
    app.on(
      "chat.message.received",
      () =>
        ({
          status: "completed",
          effects: [],
          reason: new Map([["reason", "not portable"]]),
        }) as never,
    );

    const receipt = await app.accept(messageEvent("message-31"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        status: "failed",
        effects: [],
        reason: expect.stringContaining("ReactionDraft"),
      }),
    );
  });

  it("contains a malformed ReactionDraft before reading its effects", async () => {
    const store = makeMemoryStore();
    const app = createOpenMatter({ store, integrations: {}, agents: {} });
    app.on("chat.message.received", () => null as never);

    const receipt = await app.accept(messageEvent("message-35"));

    expect(receipt.reaction).toEqual(
      expect.objectContaining({
        status: "failed",
        effects: [],
        reason: expect.stringContaining("ReactionDraft"),
      }),
    );
  });

  it("rejects a non-JSON WorkEvent before claiming durable work", async () => {
    const store = makeMemoryStore();
    const app = createOpenMatter({ store, integrations: {}, agents: {} });
    const event = {
      ...messageEvent("message-24"),
      payload: new Map([["text", "not portable"]]),
    } as never;

    await expect(app.accept(event)).rejects.toThrow("portable JSON");
    expect((await Effect.runPromise(store.inspect)).events).toEqual([]);
  });

  it("contains a null WorkEvent as a typed validation failure", async () => {
    const store = makeMemoryStore();
    const app = createOpenMatter({ store, integrations: {}, agents: {} });

    await expect(app.accept(null as never)).rejects.toThrow(
      "WorkEvent must be portable JSON data",
    );
    expect((await Effect.runPromise(store.inspect)).events).toEqual([]);
  });

  it("contains a non-JSON provider receipt as a terminal delivery failure", async () => {
    const store = makeMemoryStore();
    const chat = makeMockIntegration({ id: "chat" });
    const app = createOpenMatter({
      store,
      integrations: {
        chat: {
          ...chat.integration,
          deliver: () =>
            Effect.succeed({
              providerReceipt: new Map([["id", "not portable"]]) as never,
            }),
        },
      },
      agents: {},
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
          grants: ["chat.message.reply"],
        });
        const effect = yield* work.effect(context, {
          integrationId: "chat",
          operation: "message.reply",
          input: { text: "hello" },
        });
        return work.react.effects([effect]);
      }),
    );

    const receipt = await app.accept(messageEvent("message-25"));

    expect(receipt.deliveries).toEqual([
      expect.objectContaining({
        status: "terminal-failed",
        error: expect.stringContaining("portable JSON"),
      }),
    ]);
  });

  it("contains a null provider delivery result as a terminal failure", async () => {
    const store = makeMemoryStore();
    const chat = makeMockIntegration({ id: "chat" });
    const app = createOpenMatter({
      store,
      integrations: {
        chat: {
          ...chat.integration,
          deliver: () => Effect.succeed(null as never),
        },
      },
      agents: {},
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
          grants: ["chat.message.reply"],
        });
        const effect = yield* work.effect(context, {
          integrationId: "chat",
          operation: "message.reply",
          input: { text: "hello" },
        });
        return work.react.effects([effect]);
      }),
    );

    const receipt = await app.accept(messageEvent("message-null-delivery"));

    expect(receipt.deliveries).toEqual([
      expect.objectContaining({
        status: "terminal-failed",
        error: expect.stringContaining("Provider delivery result"),
      }),
    ]);
  });

  it("rejects a non-JSON Agent Session handle", async () => {
    const store = makeMemoryStore();
    const worker = makeMockAgentDriver({ id: "worker", output: "unused" });
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: {
        worker: {
          ...worker.driver,
          createSession: () =>
            Effect.succeed({
              id: "bad-session",
              raw: new Map([["token", "not portable"]]) as never,
            }),
        },
      },
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    await expect(app.accept(messageEvent("message-26"))).rejects.toThrow(
      "portable JSON",
    );
    const sessions = (await Effect.runPromise(store.inspect)).sessions;
    expect(sessions).toEqual([expect.objectContaining({ state: "creating" })]);
    expect(sessions[0]).not.toHaveProperty("externalHandle");
  });

  it("rejects a null Agent Session handle with a typed Driver error", async () => {
    const store = makeMemoryStore();
    const worker = makeMockAgentDriver({ id: "worker", output: "unused" });
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: {
        worker: {
          ...worker.driver,
          createSession: () => Effect.succeed(null as never),
        },
      },
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    await expect(
      app.accept(messageEvent("message-null-handle")),
    ).rejects.toThrow("Agent Session handle must be portable JSON data");
    expect((await Effect.runPromise(store.inspect)).sessions).toEqual([
      expect.objectContaining({ state: "creating" }),
    ]);
  });

  it("renews the Session lease while a remote Session is being created", async () => {
    const store = makeMemoryStore();
    const started = await Effect.runPromise(Deferred.make<void>());
    const worker = makeMockAgentDriver({ id: "worker", output: "ok" });
    const slowDriver = {
      ...worker.driver,
      createSession: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.zipRight(Effect.sleep("120 millis")),
          Effect.as({ id: "slow-session" }),
        ),
    };
    const register = (runtimeId: string) => {
      const app = createOpenMatter({
        store,
        integrations: {},
        agents: { worker: slowDriver },
        runtimeId,
        sessionLeaseMs: 30,
      });
      app.on("chat.message.received", (work) =>
        Effect.gen(function* () {
          const context = yield* work.context.project({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            items: [work.context.event()],
          });
          yield* work
            .agent("worker")
            .session({
              scopeId: "scope-1",
              workThreadId: "thread-1",
              privacyPartition: "team",
            })
            .turn({ context });
          return work.react.none();
        }),
      );
      return app;
    };

    const owner = register("runtime-owner");
    const running = Effect.runFork(
      owner.acceptEffect(messageEvent("message-28")),
    );
    await Effect.runPromise(Deferred.await(started));
    await new Promise((resolve) => setTimeout(resolve, 80));

    const contender = register("runtime-contender");
    await expect(contender.accept(messageEvent("message-29"))).rejects.toThrow(
      "Agent session is busy",
    );
    await Effect.runPromise(Fiber.interrupt(running));
  });

  it("reuses a completed logical Turn when event commit is replayed", async () => {
    let now = "2026-08-20T08:00:00.000Z";
    let contextVersion = "v1";
    let failCommit = true;
    let turnCalls = 0;
    const memory = makeMemoryStore({ clock: () => now });
    const store = {
      ...memory,
      commitTerminalReaction: (reaction, leaseToken) => {
        if (failCommit) {
          failCommit = false;
          return Effect.fail(
            new StoreError({ message: "terminal commit unavailable" }),
          );
        }
        return memory.commitTerminalReaction(reaction, leaseToken);
      },
    } satisfies typeof memory;
    const worker = makeMockAgentDriver({ id: "worker", output: "once" });
    const driver = {
      ...worker.driver,
      turn: (input: Parameters<typeof worker.driver.turn>[0]) => {
        turnCalls += 1;
        return worker.driver.turn(input);
      },
    };
    const build = (runtimeId: string) => {
      const app = createOpenMatter({
        store,
        integrations: {},
        agents: { worker: driver },
        runtimeId,
        eventLeaseMs: 30,
        clock: () => now,
      });
      app.on("chat.message.received", (work) =>
        Effect.gen(function* () {
          const context = yield* work.context.project({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            items: [
              work.context.event(),
              work.context.value({
                kind: "dynamic-state",
                value: { version: contextVersion },
                provenance: [
                  { sourceType: "application", sourceId: "dynamic-state" },
                ],
              }),
            ],
          });
          yield* work
            .agent("worker")
            .session({
              scopeId: "scope-1",
              workThreadId: "thread-1",
              privacyPartition: "team",
            })
            .turn({ context });
          return work.react.none();
        }),
      );
      return app;
    };

    const event = messageEvent("message-34");
    await expect(build("runtime-first").accept(event)).rejects.toThrow(
      "terminal commit unavailable",
    );
    now = "2026-08-20T08:01:00.000Z";
    contextVersion = "v2";
    const replay = await build("runtime-replay").accept(event);

    expect(replay.reaction.status).toBe("completed");
    expect(turnCalls).toBe(1);
    const snapshot = await Effect.runPromise(memory.inspect);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.agentEvents).toHaveLength(2);
  });

  it("recovers an idempotent Session creation after handle persistence fails", async () => {
    let now = "2026-08-20T08:00:00.000Z";
    let failOpenSave = true;
    const memory = makeMemoryStore({ clock: () => now });
    const store = {
      ...memory,
      saveSession: (
        session: Parameters<typeof memory.saveSession>[0],
        leaseToken: string,
      ) => {
        if (failOpenSave && session.state === "open") {
          failOpenSave = false;
          return Effect.fail(
            new StoreError({ message: "session handle commit unavailable" }),
          );
        }
        return memory.saveSession(session, leaseToken);
      },
    } satisfies typeof memory;
    const worker = makeMockAgentDriver({ id: "worker", output: "recovered" });
    const build = (runtimeId: string) => {
      const app = createOpenMatter({
        store,
        integrations: {},
        agents: { worker: worker.driver },
        runtimeId,
        eventLeaseMs: 30,
        clock: () => now,
      });
      app.on("chat.message.received", (work) =>
        Effect.gen(function* () {
          const context = yield* work.context.project({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            items: [work.context.event()],
          });
          yield* work
            .agent("worker")
            .session({
              scopeId: "scope-1",
              workThreadId: "thread-1",
              privacyPartition: "team",
            })
            .turn({ context });
          return work.react.none();
        }),
      );
      return app;
    };

    const event = messageEvent("message-36");
    await expect(build("runtime-first").accept(event)).rejects.toThrow(
      "session handle commit unavailable",
    );
    now = "2026-08-20T08:01:00.000Z";
    const replay = await build("runtime-replay").accept(event);

    expect(replay.reaction.status).toBe("completed");
    expect(worker.createdSessions()).toBe(1);
    expect((await Effect.runPromise(memory.inspect)).sessions).toEqual([
      expect.objectContaining({ generation: 1, state: "open" }),
    ]);
  });

  it("starts a new Session generation only for typed remote expiry", async () => {
    const store = makeMemoryStore();
    const worker = makeMockAgentDriver({ id: "worker", output: "ok" });
    let remoteExpired = false;
    const driver = {
      ...worker.driver,
      resumeSession: (
        handle: Parameters<typeof worker.driver.resumeSession>[0],
      ) =>
        remoteExpired
          ? Effect.fail(
              new AgentSessionUnavailableError({
                message: "remote session expired",
              }),
            )
          : worker.driver.resumeSession(handle),
    };
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: driver },
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    await app.accept(messageEvent("message-37"));
    remoteExpired = true;
    await app.accept(messageEvent("message-38"));

    expect(worker.createdSessions()).toBe(2);
    expect((await Effect.runPromise(store.inspect)).sessions).toEqual([
      expect.objectContaining({ generation: 1, state: "expired" }),
      expect.objectContaining({ generation: 2, state: "open" }),
    ]);
  });

  it("does not fork a Session generation for a transient resume error", async () => {
    const store = makeMemoryStore();
    const worker = makeMockAgentDriver({ id: "worker", output: "ok" });
    let transientFailure = false;
    const driver = {
      ...worker.driver,
      resumeSession: (
        handle: Parameters<typeof worker.driver.resumeSession>[0],
      ) =>
        transientFailure
          ? Effect.fail(
              new AgentDriverError({ message: "temporary transport failure" }),
            )
          : worker.driver.resumeSession(handle),
    };
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: driver },
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    await app.accept(messageEvent("message-39"));
    transientFailure = true;
    await expect(app.accept(messageEvent("message-40"))).rejects.toThrow(
      "temporary transport failure",
    );

    expect(worker.createdSessions()).toBe(1);
    expect((await Effect.runPromise(store.inspect)).sessions).toEqual([
      expect.objectContaining({ generation: 1, state: "open" }),
    ]);
  });

  it("reuses a durable permission decision after an ambiguous response", async () => {
    let now = "2026-08-20T08:00:00.000Z";
    let failResponse = true;
    let policyResult = true;
    let policyCalls = 0;
    const store = makeMemoryStore({ clock: () => now });
    const worker = makeMockAgentDriver({
      id: "worker",
      output: "approved",
      permissionRequestId: "permission-stable",
    });
    const driver = {
      ...worker.driver,
      respondToPermission: (
        input: Parameters<typeof worker.driver.respondToPermission>[0],
      ) => {
        if (failResponse) {
          failResponse = false;
          return Effect.fail(
            new AgentDriverError({
              message: "permission response acknowledgement lost",
            }),
          );
        }
        return worker.driver.respondToPermission(input);
      },
    };
    const build = (runtimeId: string) => {
      const app = createOpenMatter({
        store,
        integrations: {},
        agents: { worker: driver },
        runtimeId,
        eventLeaseMs: 30,
        clock: () => now,
        permissionPolicy: () => {
          policyCalls += 1;
          return policyResult;
        },
      });
      app.on("chat.message.received", (work) =>
        Effect.gen(function* () {
          const context = yield* work.context.project({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            items: [work.context.event()],
          });
          yield* work
            .agent("worker")
            .session({
              scopeId: "scope-1",
              workThreadId: "thread-1",
              privacyPartition: "team",
            })
            .turn({ context });
          return work.react.none();
        }),
      );
      return app;
    };

    const event = messageEvent("message-41");
    await expect(build("runtime-first").accept(event)).rejects.toThrow(
      "acknowledgement lost",
    );
    now = "2026-08-20T08:01:00.000Z";
    policyResult = false;
    await build("runtime-replay").accept(event);

    expect(policyCalls).toBe(1);
    expect(worker.permissionResponses()).toEqual([
      { requestId: "permission-stable", approved: true },
    ]);
    expect(
      (await Effect.runPromise(store.inspect)).permissionDecisions,
    ).toEqual([
      expect.objectContaining({
        requestId: "permission-stable",
        approved: true,
      }),
    ]);
  });

  it("rejects a reused permission request id with different content", async () => {
    let now = "2026-08-20T08:00:00.000Z";
    let permissionOperation = "issue.read";
    let failResponse = true;
    let policyCalls = 0;
    const store = makeMemoryStore({ clock: () => now });
    const worker = makeMockAgentDriver({
      id: "worker",
      output: "unused",
      permissionRequestId: "permission-collision",
    });
    const driver = {
      ...worker.driver,
      turn: (input: Parameters<typeof worker.driver.turn>[0]) =>
        worker.driver.turn(input).pipe(
          Stream.map((agentEvent) =>
            isPermissionRequestEvent(agentEvent)
              ? createOpenMAEvent({
                  event_id: agentEvent.event_id,
                  session_id: agentEvent.session_id,
                  turn_id: agentEvent.turn_id!,
                  seq: agentEvent.seq!,
                  type: "callback.requested",
                  occurred_at: agentEvent.occurred_at,
                  source: agentEvent.source,
                  data: {
                    ...agentEvent.data,
                    fingerprint: `permission:${permissionOperation}`,
                    params: { operation: permissionOperation },
                  },
                })
              : agentEvent,
          ),
        ),
      respondToPermission: (
        input: Parameters<typeof worker.driver.respondToPermission>[0],
      ) => {
        if (failResponse) {
          failResponse = false;
          return Effect.fail(
            new AgentDriverError({ message: "permission response lost" }),
          );
        }
        return worker.driver.respondToPermission(input);
      },
    };
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: driver },
      eventLeaseMs: 30,
      clock: () => now,
      permissionPolicy: () => {
        policyCalls += 1;
        return true;
      },
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    const event = messageEvent("message-permission-collision");
    await expect(app.accept(event)).rejects.toThrow("permission response lost");
    now = "2026-08-20T08:01:00.000Z";
    permissionOperation = "issue.delete";

    await expect(app.accept(event)).rejects.toThrow(
      "Permission request content changed",
    );
    expect(policyCalls).toBe(1);
    expect(worker.permissionResponses()).toEqual([]);
  });

  it("interrupts a partial Turn instead of joining a new Session generation", async () => {
    let now = "2026-08-20T08:00:00.000Z";
    let remoteExpired = false;
    let turnCalls = 0;
    const store = makeMemoryStore({ clock: () => now });
    const worker = makeMockAgentDriver({ id: "worker", output: "unused" });
    const driver = {
      ...worker.driver,
      resumeSession: (
        handle: Parameters<typeof worker.driver.resumeSession>[0],
      ) =>
        remoteExpired
          ? Effect.fail(
              new AgentSessionUnavailableError({
                message: "remote session expired",
              }),
            )
          : worker.driver.resumeSession(handle),
      turn: (input: Parameters<typeof worker.driver.turn>[0]) => {
        turnCalls += 1;
        const partial: OpenMAEvent = createOpenMAEvent({
          event_id: `${input.turnId}:partial`,
          session_id: input.sessionId,
          turn_id: input.turnId,
          seq: 1,
          type: "agent.message",
          occurred_at: now,
          source: { kind: "harness", harness: "test" },
          data: { text: "partial" },
        });
        return Stream.make(partial).pipe(
          Stream.concat(
            Stream.fail(
              new AgentDriverError({ message: "stream transport lost" }),
            ),
          ),
        );
      },
    };
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: driver },
      eventLeaseMs: 30,
      clock: () => now,
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    const event = messageEvent("message-42");
    await expect(app.accept(event)).rejects.toThrow("stream transport lost");
    now = "2026-08-20T08:01:00.000Z";
    remoteExpired = true;
    const replay = await app.accept(event);

    expect(replay.reaction.status).toBe("completed");
    expect(turnCalls).toBe(1);
    const snapshot = await Effect.runPromise(store.inspect);
    expect(snapshot.turns).toEqual([
      expect.objectContaining({ state: "cancelled" }),
    ]);
    expect(snapshot.agentEvents.map((agentEvent) => agentEvent.type)).toEqual([
      "agent.message",
      "turn.interrupted",
    ]);
    expect(
      new Set(snapshot.agentEvents.map((agentEvent) => agentEvent.session_id))
        .size,
    ).toBe(1);
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({ generation: 1, state: "expired" }),
    ]);
  });

  it("treats a persisted running Turn as in-flight before its first event", async () => {
    let now = "2026-08-20T08:00:00.000Z";
    let remoteExpired = false;
    let turnCalls = 0;
    const store = makeMemoryStore({ clock: () => now });
    const worker = makeMockAgentDriver({ id: "worker", output: "duplicate" });
    const driver = {
      ...worker.driver,
      resumeSession: (
        handle: Parameters<typeof worker.driver.resumeSession>[0],
      ) =>
        remoteExpired
          ? Effect.fail(
              new AgentSessionUnavailableError({
                message: "remote session expired before first event",
              }),
            )
          : worker.driver.resumeSession(handle),
      turn: (input: Parameters<typeof worker.driver.turn>[0]) => {
        turnCalls += 1;
        return turnCalls === 1
          ? Stream.fail(
              new AgentDriverError({ message: "stream failed before emit" }),
            )
          : worker.driver.turn(input);
      },
    };
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: driver },
      eventLeaseMs: 30,
      clock: () => now,
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        return work.react.none();
      }),
    );

    const event = messageEvent("message-42-zero-event");
    await expect(app.accept(event)).rejects.toThrow(
      "stream failed before emit",
    );
    now = "2026-08-20T08:01:00.000Z";
    remoteExpired = true;
    const replay = await app.accept(event);

    expect(replay.reaction.status).toBe("completed");
    expect(turnCalls).toBe(1);
    const snapshot = await Effect.runPromise(store.inspect);
    expect(snapshot.turns).toEqual([
      expect.objectContaining({ state: "cancelled" }),
    ]);
    expect(snapshot.agentEvents.map((agentEvent) => agentEvent.type)).toEqual([
      "turn.interrupted",
    ]);
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({ generation: 1, state: "expired" }),
    ]);
  });

  it("allocates Session finalizer state per execution of one Effect value", async () => {
    const store = makeMemoryStore();
    const started = await Effect.runPromise(Deferred.make<void>());
    const worker = makeMockAgentDriver({ id: "worker", output: "unused" });
    const driver = {
      ...worker.driver,
      turn: (input: Parameters<typeof worker.driver.turn>[0]) => {
        const timestamp = new Date().toISOString();
        const output: OpenMAEvent = createOpenMAEvent({
          event_id: `${input.turnId}:output`,
          session_id: input.sessionId,
          turn_id: input.turnId,
          seq: 1,
          type: "agent.message",
          occurred_at: timestamp,
          source: { kind: "harness", harness: "test" },
          data: { text: "once" },
        });
        const terminal: OpenMAEvent = createOpenMAEvent({
          event_id: `${input.turnId}:terminal`,
          session_id: input.sessionId,
          turn_id: input.turnId,
          seq: 2,
          type: "turn.completed",
          occurred_at: timestamp,
          source: { kind: "harness", harness: "test" },
          data: {},
        });
        return Stream.fromEffect(
          Deferred.succeed(started, undefined).pipe(
            Effect.zipRight(Effect.sleep("80 millis")),
            Effect.as(output),
          ),
        ).pipe(Stream.concat(Stream.make(terminal)));
      },
    };
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: driver },
      sessionLeaseMs: 30,
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        const shared = work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        const owner = yield* Effect.fork(shared);
        yield* Deferred.await(started);
        const contender = yield* Effect.exit(shared);
        expect(contender._tag).toBe("Failure");
        yield* Fiber.join(owner);
        return work.react.none();
      }),
    );

    const receipt = await app.accept(messageEvent("message-43"));

    expect(receipt.reaction.status).toBe("completed");
    expect((await Effect.runPromise(store.inspect)).turns).toEqual([
      expect.objectContaining({ state: "completed" }),
    ]);
  });

  it("commits the authorized Reaction snapshot, not retained user references", async () => {
    const commitStarted = await Effect.runPromise(Deferred.make<void>());
    const continueCommit = await Effect.runPromise(Deferred.make<void>());
    const memory = makeMemoryStore();
    const store = {
      ...memory,
      commitTerminalReaction: (reaction, leaseToken) =>
        Deferred.succeed(commitStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(continueCommit)),
          Effect.zipRight(memory.commitTerminalReaction(reaction, leaseToken)),
        ),
    } satisfies typeof memory;
    const chat = makeMockIntegration({ id: "chat" });
    let retainedEffect: WorkEffect | undefined;
    const app = createOpenMatter({
      store,
      integrations: { chat: chat.integration },
      agents: {},
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
          grants: ["chat.message.reply"],
        });
        const effect = yield* work.effect(context, {
          integrationId: "chat",
          operation: "message.reply",
          input: { text: "authorized" },
        });
        retainedEffect = effect;
        return work.react.effects([effect]);
      }),
    );

    const running = Effect.runFork(
      app.acceptEffect(messageEvent("message-44")),
    );
    await Effect.runPromise(Deferred.await(commitStarted));
    if (retainedEffect === undefined) throw new Error("expected WorkEffect");
    (retainedEffect.input as { text: string }).text = "tampered";
    (retainedEffect as { operation: string }).operation = "message.delete";
    await Effect.runPromise(Deferred.succeed(continueCommit, undefined));
    const receipt = await Effect.runPromise(Fiber.join(running));

    expect(receipt.reaction.effects).toEqual([
      expect.objectContaining({
        operation: "message.reply",
        input: { text: "authorized" },
      }),
    ]);
    expect(chat.delivered()).toEqual([
      expect.objectContaining({
        operation: "message.reply",
        input: { text: "authorized" },
      }),
    ]);
  });

  it("passes the durable Context and allow snapshot across async boundaries", async () => {
    const capabilitiesStarted = await Effect.runPromise(Deferred.make<void>());
    const continueCapabilities = await Effect.runPromise(Deferred.make<void>());
    const store = makeMemoryStore();
    const worker = makeMockAgentDriver({ id: "worker", output: "ok" });
    const received: Array<Parameters<typeof worker.driver.turn>[0]> = [];
    const driver = {
      ...worker.driver,
      capabilities: () =>
        Deferred.succeed(capabilitiesStarted, undefined).pipe(
          Effect.zipRight(Deferred.await(continueCapabilities)),
          Effect.zipRight(worker.driver.capabilities()),
        ),
      turn: (input: Parameters<typeof worker.driver.turn>[0]) => {
        received.push(input);
        return worker.driver.turn(input);
      },
    };
    let retainedContext: ContextProjection | undefined;
    const retainedAllow: string[] = [];
    const app = createOpenMatter({
      store,
      integrations: {},
      agents: { worker: driver },
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [work.context.event()],
        });
        retainedContext = context;
        yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context, allow: retainedAllow });
        return work.react.none();
      }),
    );

    const running = Effect.runFork(
      app.acceptEffect(messageEvent("message-45")),
    );
    await Effect.runPromise(Deferred.await(capabilitiesStarted));
    if (retainedContext === undefined) throw new Error("expected context");
    (retainedContext.grants as string[]).push("chat.admin");
    retainedAllow.push("chat.admin");
    await Effect.runPromise(Deferred.succeed(continueCapabilities, undefined));
    await Effect.runPromise(Fiber.join(running));

    expect(received).toHaveLength(1);
    expect(received[0]?.context.grants).toEqual([]);
    expect(received[0]?.allow).toEqual([]);
    expect(
      (await Effect.runPromise(store.inspect)).contexts[0]?.grants,
    ).toEqual([]);
  });
});

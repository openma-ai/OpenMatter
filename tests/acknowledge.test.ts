import { describe, expect, it } from "vitest";
import { makeMockAgentDriver } from "@openma/matter-agent-mock";
import { makeMockIntegration } from "@openma/matter-integration-mock";
import {
  IntegrationError,
  type WorkIntegration,
} from "@openma/matter/integration";
import { createOpenMatter, type WorkContext } from "@openma/matter/runtime";
import { makeMemoryStore } from "@openma/matter-store-memory";
import type { WorkEvent } from "@openma/matter";
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

const project = (work: WorkContext, grants: readonly string[]) =>
  work.context.project({
    scopeId: "scope-1",
    workThreadId: "thread-1",
    items: [work.context.event()],
    grants,
  });

/** An integration whose every delivery fails with the given error. */
const failing = (error: IntegrationError): WorkIntegration => ({
  manifest: {
    id: "chat",
    displayName: "Chat",
    events: [],
    operations: ["*"],
  },
  ingest: () => Effect.succeed([]),
  deliver: () => Effect.fail(error),
});

describe("WorkContext.acknowledge", () => {
  it("delivers before the Agent turn and stays out of the Reaction", async () => {
    const store = makeMemoryStore();
    const chat = makeMockIntegration({ id: "chat" });
    const deliveredBeforeTurn: number[] = [];
    const worker = makeMockAgentDriver({ id: "worker", output: "answer" });
    const app = createOpenMatter({
      store,
      integrations: { chat: chat.integration },
      agents: { worker: worker.driver },
    });
    const acks: unknown[] = [];
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* project(work, [
          "chat.reaction.add",
          "chat.message.reply",
        ]);
        acks.push(
          yield* work.acknowledge(context, {
            integrationId: "chat",
            operation: "reaction.add",
            input: { emoji: "OnIt" },
          }),
        );
        deliveredBeforeTurn.push(chat.delivered().length);
        const turn = yield* work
          .agent("worker")
          .session({
            scopeId: "scope-1",
            workThreadId: "thread-1",
            privacyPartition: "team",
          })
          .turn({ context });
        const reply = yield* work.effect(context, {
          integrationId: "chat",
          operation: "message.reply",
          input: { text: turn.output ?? null },
        });
        return work.react.effects([reply]);
      }),
    );

    const receipt = await app.accept(messageEvent("m1"));

    expect(deliveredBeforeTurn).toEqual([1]);
    expect(acks).toEqual([
      { status: "delivered", receipt: { id: "mock:chat:m1:ack:1" } },
    ]);
    expect(
      chat.delivered().map((e) => [e.operation, e.idempotencyKey]),
    ).toEqual([
      ["reaction.add", "chat:m1:ack:1"],
      // The acknowledgement does not shift the Effect's key.
      ["message.reply", "chat:m1:effect:1"],
    ]);
    expect(receipt.reaction.status).toBe("completed");
    expect(receipt.reaction.effects.map((e) => e.operation)).toEqual([
      "message.reply",
    ]);
    const inspected = await Effect.runPromise(store.inspect);
    expect(inspected.deliveries.map((d) => d.operation)).toEqual([
      "message.reply",
    ]);
  });

  it("reports a delivery failure as a result and lets the handler go on", async () => {
    const results: unknown[] = [];
    const run = async (error: IntegrationError, id: string) => {
      const app = createOpenMatter({
        store: makeMemoryStore(),
        integrations: { chat: failing(error) },
        agents: {},
      });
      app.on("chat.message.received", (work) =>
        Effect.gen(function* () {
          const context = yield* project(work, ["chat.reaction.add"]);
          results.push(
            yield* work.acknowledge(context, {
              integrationId: "chat",
              operation: "reaction.add",
              input: {},
            }),
          );
          return work.react.none("acknowledged");
        }),
      );
      return app.accept(messageEvent(id));
    };

    const refused = await run(
      new IntegrationError({
        message: "rate limited",
        retryable: true,
        effectState: "not-applied",
      }),
      "m2",
    );
    const unknown = await run(
      new IntegrationError({ message: "socket closed", retryable: true }),
      "m3",
    );

    expect(refused.reaction).toEqual(
      expect.objectContaining({ status: "completed", reason: "acknowledged" }),
    );
    expect(unknown.reaction.status).toBe("completed");
    expect(results).toEqual([
      { status: "failed", reason: "rate limited", retryable: true },
      { status: "uncertain", reason: "socket closed" },
    ]);
  });

  it("turns an integration defect into an uncertain result", async () => {
    const app = createOpenMatter({
      store: makeMemoryStore(),
      integrations: {
        chat: {
          ...failing(new IntegrationError({ message: "x", retryable: false })),
          deliver: () => Effect.die(new Error("boom")),
        },
      },
      agents: {},
    });
    const results: unknown[] = [];
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* project(work, ["chat.reaction.add"]);
        results.push(
          yield* work.acknowledge(context, {
            integrationId: "chat",
            operation: "reaction.add",
            input: {},
          }),
        );
        return work.react.none();
      }),
    );

    const receipt = await app.accept(messageEvent("m4"));

    expect(receipt.reaction.status).toBe("completed");
    expect(results).toEqual([
      {
        status: "uncertain",
        reason: "The integration failed while delivering",
      },
    ]);
  });

  it("is authorized like an Effect", async () => {
    const chat = makeMockIntegration({ id: "chat" });
    const app = createOpenMatter({
      store: makeMemoryStore(),
      integrations: { chat: chat.integration },
      agents: {},
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* project(work, ["chat.message.reply"]);
        yield* work.acknowledge(context, {
          integrationId: "chat",
          operation: "reaction.add",
          input: {},
        });
        return work.react.none();
      }),
    );

    const receipt = await app.accept(messageEvent("m5"));

    expect(receipt.reaction.status).toBe("failed");
    expect(receipt.reaction.reason).toContain("grant");
    expect(chat.delivered()).toEqual([]);
  });

  it("refuses mutation preconditions", async () => {
    const chat = makeMockIntegration({ id: "chat" });
    const app = createOpenMatter({
      store: makeMemoryStore(),
      integrations: { chat: chat.integration },
      agents: {},
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* project(work, ["chat.reaction.add"]);
        yield* work.acknowledge(context, {
          integrationId: "chat",
          operation: "reaction.add",
          input: {},
          mutation: { kind: "none" } as never,
        });
        return work.react.none();
      }),
    );

    const receipt = await app.accept(messageEvent("m6"));

    expect(receipt.reaction.status).toBe("failed");
    expect(receipt.reaction.reason).toContain("mutation preconditions");
    expect(chat.delivered()).toEqual([]);
  });

  it("cannot be smuggled into a Reaction", async () => {
    const chat = makeMockIntegration({ id: "chat" });
    const store = makeMemoryStore();
    const app = createOpenMatter({
      store,
      integrations: { chat: chat.integration },
      agents: {},
    });
    app.on("chat.message.received", (work) =>
      Effect.gen(function* () {
        const context = yield* project(work, ["chat.reaction.add"]);
        yield* work.acknowledge(context, {
          integrationId: "chat",
          operation: "reaction.add",
          input: {},
        });
        // Rebuild the acknowledgement as an Effect and try to replay it.
        return work.react.effects([
          {
            schemaVersion: "0.1",
            id: "replayed",
            eventId: work.event.id,
            integrationId: "chat",
            operation: "reaction.add",
            idempotencyKey: "chat:m7:ack:1",
            input: {},
          },
        ]);
      }),
    );

    const receipt = await app.accept(messageEvent("m7"));

    expect(receipt.reaction.status).toBe("failed");
    expect(receipt.reaction.reason).toContain("authorized");
    expect(chat.delivered()).toHaveLength(1);
  });
});

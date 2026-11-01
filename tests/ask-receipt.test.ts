import { describe, expect, it } from "vitest";
import {
  makeMockAgentDriver,
  type MockOperationCall,
} from "@openma/matter-agent-mock";
import {
  ASK_ANSWER_EXTENSION,
  matchOpenAsk,
  type OperationCallResult,
  type WorkEffect,
  type WorkEvent,
} from "@openma/matter";
import type { WorkIntegration } from "@openma/matter/integration";
import { createOpenMatter } from "@openma/matter/runtime";
import { makeMemoryStore } from "@openma/matter-store-memory";
import { Effect } from "effect";

interface ChatMessage {
  readonly id: string;
  readonly type?: "mentioned" | "received" | "recalled";
  readonly thread?: string;
  readonly sender?: string;
  readonly app?: boolean;
  readonly text?: string;
  readonly conversation?: string;
}

const chatEvent = (m: ChatMessage): WorkEvent => ({
  schemaVersion: "0.1",
  id: m.id,
  type: `chat.message.${m.type ?? "received"}`,
  occurredAt: "2026-08-20T08:00:00.000Z",
  receivedAt: "2026-08-20T08:00:01.000Z",
  idempotencyKey: `chat:${m.id}`,
  source: {
    provider: "chat",
    authority: "workspace-1",
    conversationId: m.conversation ?? "room-1",
    messageId: m.id,
  },
  payload: {
    room: m.conversation ?? "room-1",
    thread: m.thread ?? "t1",
    sender: m.sender ?? "alice",
    app: m.app ?? false,
    text: m.text ?? `text of ${m.id}`,
  },
});

const chatIntegration = () => {
  const delivered: WorkEffect[] = [];
  const integration: WorkIntegration = {
    manifest: {
      id: "chat",
      displayName: "Chat",
      events: [
        "chat.message.mentioned",
        "chat.message.received",
        "chat.message.recalled",
      ],
      operations: ["reply"],
      tools: {
        reply: {
          description: "Reply to the message",
          inputSchema: { type: "object" },
          freshness: "best-effort",
        },
      },
    },
    ingest: () => Effect.succeed([]),
    deliver: (effect) => {
      delivered.push(effect);
      return Effect.succeed({ providerReceipt: { n: delivered.length } });
    },
    observe: (event) => {
      const p = event.payload as Record<string, string | boolean>;
      if (event.type === "chat.message.recalled") {
        return {
          conversationId: String(p.room),
          kind: "recall",
          messageId: String(p.target),
        };
      }
      return {
        conversationId: String(p.room),
        kind: event.type === "chat.message.mentioned" ? "mention" : "message",
        threadId: String(p.thread),
        messageId: event.id,
        sender: { id: String(p.sender), kind: p.app ? "app" : "human" },
        text: String(p.text),
      };
    },
  };
  return { integration, delivered };
};

const reply = (
  callId: string,
  text = "the answer",
  ask = false,
): MockOperationCall => ({
  callId,
  integrationId: "chat",
  operation: "reply",
  input: ask ? { text, expectReply: true } : { text },
});

const makeHarness = (options: {
  readonly calls?: readonly MockOperationCall[];
  readonly startOnAnswer?: boolean;
  readonly onResponse?: (
    callbackId: string,
    app: ReturnType<typeof createOpenMatter>,
  ) => Promise<void>;
}) => {
  const memory = makeMemoryStore();
  const chat = chatIntegration();
  const worker = makeMockAgentDriver({
    id: "worker",
    output: "done",
    operationCalls: options.calls ?? [reply("c1")],
  });
  const observer = makeMockAgentDriver({
    id: "observer",
    output: "noted",
  });
  let app: ReturnType<typeof createOpenMatter>;
  const driver =
    options.onResponse === undefined
      ? worker.driver
      : {
          ...worker.driver,
          respondToCallback: (input: {
            readonly callbackId: string;
            readonly session: unknown;
            readonly result: unknown;
          }) =>
            worker.driver.respondToCallback!(input as never).pipe(
              Effect.zipRight(
                Effect.promise(() =>
                  options.onResponse!(input.callbackId, app),
                ),
              ),
            ),
        };
  app = createOpenMatter({
    store: memory,
    integrations: { chat: chat.integration },
    agents: { worker: driver, observer: observer.driver },
  });
  app.observe(["chat.message.received", "chat.message.recalled"]);

  const turns: string[] = [];
  const runTurn = (
    work: Parameters<Parameters<typeof app.on>[1]>[0],
    agent: "worker" | "observer",
  ) =>
    Effect.gen(function* () {
      const context = yield* work.context.project({
        scopeId: "scope-1",
        workThreadId: "thread-1",
        items: [work.context.event()],
        grants: ["chat.reply"],
      });
      const result = yield* work
        .agent(agent)
        .session({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          privacyPartition: "team",
        })
        .turn({ context, allow: ["chat.reply"] });
      turns.push(result.turn.id);
      return work.react.none();
    });

  app.on("chat.message.mentioned", (work) =>
    work.event.id === "ask" ? runTurn(work, "worker") : work.react.none(),
  );
  app.on("chat.message.received", (work) =>
    options.startOnAnswer === true && work.event.id === "answer"
      ? runTurn(work, "observer")
      : work.react.none(),
  );

  return { app, memory, chat, worker, turns };
};

const resultOf = (worker: ReturnType<typeof makeMockAgentDriver>) =>
  worker
    .callbackResponses()
    .map((response) => response.result as unknown as OperationCallResult);

const snapshotOf = (memory: ReturnType<typeof makeMemoryStore>) =>
  Effect.runPromise(memory.inspect);

describe("ask / expect-reply receipts", () => {
  it("records an open ask for a delivered reply marked expectReply", async () => {
    const h = makeHarness({ calls: [reply("ask-1", "Which env?", true)] });
    await h.app.accept(chatEvent({ id: "old", sender: "bob" }));
    await h.app.accept(
      chatEvent({ id: "ask", type: "mentioned", sender: "alice" }),
    );

    expect(resultOf(h.worker)).toEqual([
      { status: "delivered", receipt: { n: 1 } },
    ]);
    const snapshot = await snapshotOf(h.memory);
    expect(snapshot.openAsks).toEqual([
      expect.objectContaining({
        schemaVersion: "0.1",
        conversationKey: JSON.stringify(["chat", "workspace-1", "room-1"]),
        conversationId: "room-1",
        threadId: "t1",
        outboxId: `${h.turns[0]}:call:ask-1`,
        triggerEventId: "ask",
        turnId: h.turns[0],
        callId: "ask-1",
        seenRevision: 2,
        status: "open",
        _meta: { text: "Which env?", expectReply: true },
      }),
    ]);
  });

  it("accepts an ask marker under opaque host _meta", async () => {
    const h = makeHarness({
      calls: [
        {
          callId: "ask-meta",
          integrationId: "chat",
          operation: "reply",
          input: {
            text: "Which env?",
            _meta: { expectReply: true, host: "pi-bot" },
          },
        },
      ],
    });
    await h.app.accept(chatEvent({ id: "ask", type: "mentioned" }));

    const snapshot = await snapshotOf(h.memory);
    expect(snapshot.openAsks[0]).toMatchObject({
      outboxId: `${h.turns[0]}:call:ask-meta`,
      status: "open",
      _meta: { expectReply: true, host: "pi-bot" },
    });
  });

  it("matches the next human message as the answer, still through a new Turn", async () => {
    const h = makeHarness({
      calls: [reply("ask-1", "Which env?", true)],
      startOnAnswer: true,
    });
    await h.app.accept(chatEvent({ id: "ask", type: "mentioned" }));
    const askTurn = h.turns[0]!;

    await h.app.accept(
      chatEvent({ id: "answer", sender: "alice", text: "staging" }),
    );

    const snapshot = await snapshotOf(h.memory);
    expect(snapshot.openAsks).toEqual([
      expect.objectContaining({
        outboxId: `${askTurn}:call:ask-1`,
        status: "answered",
        answer: expect.objectContaining({
          eventId: "answer",
          revision: 2,
          messageId: "answer",
          threadId: "t1",
        }),
      }),
    ]);
    const answer = snapshot.events.find((event) => event.id === "answer")!;
    expect(answer.extensions?.[ASK_ANSWER_EXTENSION]).toMatchObject({
      ask: { outboxId: `${askTurn}:call:ask-1`, turnId: askTurn },
      answer: { eventId: "answer", revision: 2 },
    });
    // A human message is an ordinary Event: it is not merged into the ended
    // Turn, and its own handler opens a new Turn when it asks for one.
    expect(h.turns).toHaveLength(2);
    expect(h.turns[0]).toBe(askTurn);
    expect(h.turns[1]).not.toBe(askTurn);
    expect(snapshot.turns.map((turn) => turn.id)).toHaveLength(2);
    expect(snapshot.turns[1]!.triggerEventId).toBe("answer");
  });

  it("does not match a human message when no ask is open", async () => {
    const h = makeHarness({ calls: [reply("c1")], startOnAnswer: true });
    await h.app.accept(chatEvent({ id: "ask", type: "mentioned" }));
    await h.app.accept(chatEvent({ id: "answer", sender: "alice" }));

    const snapshot = await snapshotOf(h.memory);
    expect(snapshot.openAsks).toEqual([]);
    const answer = snapshot.events.find((event) => event.id === "answer")!;
    expect(answer.extensions?.[ASK_ANSWER_EXTENSION]).toBeUndefined();
    expect(matchOpenAsk(snapshot.conversationEntries[1]!, [])).toBeUndefined();
  });

  it("keeps freshness for the old Turn after the ask was answered", async () => {
    const h = makeHarness({
      calls: [reply("ask-1", "Which env?", true), reply("reply-2")],
      onResponse: async (callbackId, app) => {
        if (callbackId !== "ask-1") return;
        await app.accept(
          chatEvent({ id: "answer", sender: "alice", text: "staging" }),
        );
      },
    });
    await h.app.accept(chatEvent({ id: "ask", type: "mentioned" }));

    expect(resultOf(h.worker).map((result) => result.status)).toEqual([
      "delivered",
      "conflict",
    ]);
    expect(h.chat.delivered).toHaveLength(1);
    const snapshot = await snapshotOf(h.memory);
    expect(snapshot.openAsks[0]?.status).toBe("answered");
    // The old Turn did not merge the answer: it raced it and got a conflict.
    expect(h.turns).toEqual([h.turns[0]]);
    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.operationCalls[1]?.result).toMatchObject({
      status: "conflict",
      effect: "not-applied",
      conflict: { reason: "newer_messages" },
    });
  });
});

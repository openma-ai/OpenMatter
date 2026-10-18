import { describe, expect, it } from "vitest";
import {
  makeMockAgentDriver,
  type MockOperationCall,
} from "@openma/matter-agent-mock";
import type {
  FreshnessPolicy,
  OperationCallResult,
  WorkEffect,
  WorkEvent,
} from "@openma/matter";
import type { WorkIntegration } from "@openma/matter/integration";
import { createOpenMatter } from "@openma/matter/runtime";
import { makeMemoryStore } from "@openma/matter-store-memory";
import type { OpenMatterStore } from "@openma/matter/store";
import { Effect } from "effect";

interface ChatMessage {
  readonly id: string;
  readonly type?: "mentioned" | "received" | "recalled";
  readonly thread?: string;
  readonly sender?: string;
  readonly app?: boolean;
  readonly text?: string;
  /** For a recall: the recalled message. */
  readonly target?: string;
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
    ...(m.target === undefined ? {} : { target: m.target }),
  },
});

const chatIntegration = (guarded = true) => {
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
          ...(guarded ? { freshness: "best-effort" as const } : {}),
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

const reply = (callId: string): MockOperationCall => ({
  callId,
  integrationId: "chat",
  operation: "reply",
  input: { text: "the answer" },
});

/**
 * One mention starts a Turn. `during` are accepted while the Agent works,
 * before it calls the reply tool; `before` are accepted before the mention.
 */
const scenario = async (opts: {
  readonly during?: readonly ChatMessage[];
  readonly before?: readonly ChatMessage[];
  readonly calls?: readonly MockOperationCall[];
  readonly freshness?: FreshnessPolicy;
  readonly guarded?: boolean;
  readonly observe?: boolean;
  readonly wrapStore?: (store: OpenMatterStore) => OpenMatterStore;
}) => {
  const memory = makeMemoryStore();
  const store = opts.wrapStore?.(memory) ?? memory;
  const chat = chatIntegration(opts.guarded ?? true);
  const worker = makeMockAgentDriver({
    id: "worker",
    output: "done",
    operationCalls: opts.calls ?? [reply("c1")],
  });
  const app = createOpenMatter({
    store,
    integrations: { chat: chat.integration },
    agents: { worker: worker.driver },
  });
  if (opts.observe ?? true) {
    app.observe(["chat.message.received", "chat.message.recalled"]);
  }
  app.on("chat.message.mentioned", (work) =>
    Effect.gen(function* () {
      // Only the question starts a Turn; later mentions are just messages.
      if (work.event.id !== "ask") return work.react.none();
      for (const m of opts.during ?? []) {
        yield* Effect.promise(() => app.accept(chatEvent(m)));
      }
      const context = yield* work.context.project({
        scopeId: "scope-1",
        workThreadId: "thread-1",
        items: [work.context.event()],
        grants: ["chat.reply"],
      });
      yield* work
        .agent("worker")
        .session({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          privacyPartition: "team",
        })
        .turn({
          context,
          allow: ["chat.reply"],
          ...(opts.freshness === undefined
            ? {}
            : { freshness: opts.freshness }),
        });
      return work.react.none();
    }),
  );
  for (const m of opts.before ?? []) await app.accept(chatEvent(m));
  await app.accept(
    chatEvent({ id: "ask", type: "mentioned", sender: "alice" }),
  );
  return {
    chat,
    results: worker
      .callbackResponses()
      .map((r) => r.result as unknown as OperationCallResult),
    snapshot: await Effect.runPromise(memory.inspect),
  };
};

describe("conversation freshness for an Agent's writes", () => {
  it("delivers a reply when nothing newer counts", async () => {
    const t = await scenario({ before: [{ id: "old", sender: "bob" }] });
    expect(t.results).toEqual([{ status: "delivered", receipt: { n: 1 } }]);
    expect(t.chat.delivered).toHaveLength(1);
    // The call records the revision it was checked at: old (1), ask (2).
    expect(t.snapshot.operationCalls[0]!.conversation).toEqual({
      key: JSON.stringify(["chat", "workspace-1", "room-1"]),
      revision: 2,
    });
  });

  it("returns newer messages as a conflict without delivering", async () => {
    const t = await scenario({
      during: [{ id: "fix", sender: "alice", text: "sorry, I meant staging" }],
    });
    expect(t.chat.delivered).toEqual([]);
    expect(t.results).toEqual([
      {
        status: "conflict",
        effect: "not-applied",
        conflict: {
          reason: "newer_messages",
          messages: [
            {
              kind: "message",
              occurredAt: "2026-08-20T08:00:00.000Z",
              threadId: "t1",
              messageId: "fix",
              sender: { id: "alice", kind: "human" },
              text: "sorry, I meant staging",
            },
          ],
        },
        seenRevision: 2,
      },
    ]);
    expect(t.snapshot.operationCalls[0]).toMatchObject({
      state: "completed",
      result: { status: "conflict" },
    });
  });

  it("lets the Agent reply after it has been shown the newer messages", async () => {
    const t = await scenario({
      during: [{ id: "fix", sender: "alice" }],
      calls: [reply("c1"), reply("c2")],
    });
    expect(t.results.map((r) => r.status)).toEqual(["conflict", "delivered"]);
    expect(t.chat.delivered).toHaveLength(1);
    expect(t.chat.delivered[0]!.id).toMatch(/:call:c2$/);
  });

  it("answers a repeated callback id with the stored conflict", async () => {
    const t = await scenario({
      during: [{ id: "fix", sender: "alice" }],
      calls: [reply("c1"), reply("c1")],
    });
    expect(t.results.map((r) => r.status)).toEqual(["conflict", "conflict"]);
    expect(t.chat.delivered).toEqual([]);
  });

  it("by default counts human messages, mentions, and recalls in the thread only", async () => {
    const t = await scenario({
      during: [
        { id: "bot", sender: "bot", app: true },
        { id: "elsewhere", sender: "bob", thread: "t2" },
        { id: "other-room", sender: "bob", conversation: "room-2" },
      ],
    });
    expect(t.results).toEqual([{ status: "delivered", receipt: { n: 1 } }]);

    const mention = await scenario({
      during: [{ id: "again", type: "mentioned", sender: "bob" }],
    });
    expect(mention.results[0]!.status).toBe("conflict");
  });

  it("counts the recall of the question itself, with the question's thread and sender", async () => {
    const t = await scenario({
      during: [{ id: "undo", type: "recalled", target: "ask" }],
    });
    expect(t.results[0]).toMatchObject({
      status: "conflict",
      conflict: {
        messages: [
          {
            kind: "recall",
            messageId: "ask",
            threadId: "t1",
            sender: { id: "alice", kind: "human" },
          },
        ],
      },
    });
  });

  it("applies the configured scope, senders, and kinds", async () => {
    const during: ChatMessage[] = [
      { id: "elsewhere", sender: "bob", thread: "t2" },
    ];
    const chatWide = await scenario({
      during,
      freshness: {
        scope: "conversation",
        senders: "humans",
        kinds: ["message"],
      },
    });
    expect(chatWide.results[0]!.status).toBe("conflict");

    const requesterOnly = await scenario({
      during: [{ id: "bob-says", sender: "bob" }],
      freshness: { scope: "thread", senders: "requester", kinds: ["message"] },
    });
    expect(requesterOnly.results[0]!.status).toBe("delivered");

    const named = await scenario({
      during: [{ id: "bob-says", sender: "bob" }],
      freshness: {
        scope: "thread",
        senders: { ids: ["bob"] },
        kinds: ["message"],
      },
    });
    expect(named.results[0]!.status).toBe("conflict");

    const anyone = await scenario({
      during: [{ id: "bot", sender: "bot", app: true }],
      freshness: { scope: "thread", senders: "anyone", kinds: ["message"] },
    });
    expect(anyone.results[0]!.status).toBe("conflict");

    const mentionsOnly = await scenario({
      during: [{ id: "bob-says", sender: "bob" }],
      freshness: { scope: "thread", senders: "humans", kinds: ["mention"] },
    });
    expect(mentionsOnly.results[0]!.status).toBe("delivered");
  });

  it("persists the Turn's freshness policy", async () => {
    const policy: FreshnessPolicy = {
      scope: "conversation",
      senders: "anyone",
      kinds: ["message"],
    };
    const t = await scenario({ freshness: policy });
    expect(t.snapshot.turns[0]!.freshness).toEqual(policy);
  });

  it("checks nothing for an operation that does not declare freshness, or events no Loop observes", async () => {
    const unguarded = await scenario({
      guarded: false,
      during: [{ id: "fix", sender: "alice" }],
    });
    expect(unguarded.results[0]!.status).toBe("delivered");
    expect(unguarded.snapshot.operationCalls[0]!.conversation).toBeUndefined();

    const unobserved = await scenario({
      observe: false,
      during: [{ id: "fix", sender: "alice" }],
    });
    expect(unobserved.results[0]!.status).toBe("delivered");
    // The trigger is still recorded, because a handler handles its type.
    expect(
      unobserved.snapshot.conversationEntries.map((e) => e.eventId),
    ).toEqual(["ask"]);
  });

  it("checks again when a message lands between the check and the call record", async () => {
    let injected = false;
    const t = await scenario({
      wrapStore: (store) => ({
        ...store,
        listConversationEntries: (key, after) =>
          store.listConversationEntries(key, after).pipe(
            Effect.tap(() =>
              injected
                ? Effect.void
                : store
                    .recordConversationEntry({
                      conversationKey: key,
                      eventId: "racer",
                      kind: "message",
                      threadId: "t1",
                      sender: { id: "bob", kind: "human" },
                      occurredAt: "2026-08-20T08:00:02.000Z",
                    })
                    .pipe(Effect.tap(() => (injected = true))),
            ),
          ),
      }),
    });
    expect(injected).toBe(true);
    expect(t.chat.delivered).toEqual([]);
    expect(t.results[0]).toMatchObject({
      status: "conflict",
      seenRevision: 2,
      conflict: { messages: [{ sender: { id: "bob" } }] },
    });
  });
});

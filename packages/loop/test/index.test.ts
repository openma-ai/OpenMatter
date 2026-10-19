import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineLoop,
  isGuestLoop,
  loadLoop,
  loopRunAs,
  type ContextProjection,
  type LoopHost,
  type WorkEffect,
  type WorkEvent,
} from "@openma/matter-loop";
import { describe, expect, it } from "vitest";

const event = (type = "chat.message.received"): WorkEvent => ({
  schemaVersion: "0.1",
  id: "event-1",
  type,
  occurredAt: "2026-08-23T08:00:00.000Z",
  receivedAt: "2026-08-23T08:00:01.000Z",
  idempotencyKey: "chat:event-1",
  source: { provider: "chat", authority: "workspace-1" },
  payload: { text: "hello" },
});

const projection: ContextProjection = {
  schemaVersion: "0.1",
  id: "context-1",
  scopeId: "scope-1",
  workThreadId: "thread-1",
  triggerEventId: "event-1",
  items: [],
  grants: ["chat.message.reply"],
  digest: "digest",
  createdAt: "2026-08-23T08:00:02.000Z",
};

const effect: WorkEffect = {
  schemaVersion: "0.1",
  id: "effect-1",
  eventId: "event-1",
  integrationId: "chat",
  operation: "message.reply",
  idempotencyKey: "effect-1",
  input: { text: "hi" },
};

/** A LoopHost that records every call and answers with fixed records. */
const recordingHost = () => {
  const calls: unknown[][] = [];
  const host: LoopHost = {
    projectContext: async (input) => {
      calls.push(["projectContext", input]);
      return projection;
    },
    createEffect: async (context, input) => {
      calls.push(["createEffect", context.id, input]);
      return effect;
    },
    acknowledge: async (context, input) => {
      calls.push(["acknowledge", context.id, input]);
      return { status: "delivered" };
    },
    agentTurn: async (agentId, binding, input) => {
      calls.push(["agentTurn", agentId, binding, input.context.id]);
      return {
        sessionId: "session-1",
        turnId: "turn-1",
        outcome: "completed",
        output: "reply",
        events: [],
      };
    },
    agentCancel: async (agentId, binding) => {
      calls.push(["agentCancel", agentId, binding]);
      return { status: "idle" };
    },
  };
  return { host, calls };
};

const schema = {
  type: "object",
  properties: {
    greeting: { type: "string", default: "hello" },
    agentId: { type: "string" },
  },
  required: ["agentId"],
} as const;

describe("@openma/matter-loop", () => {
  it("defines a frozen guest Loop whose definition is plain JSON", () => {
    const loop = defineLoop(
      { id: "greeter", configSchema: schema, runAs: "app" },
      () => undefined,
    );
    expect(loop.kind).toBe("guest");
    expect(isGuestLoop(loop)).toBe(true);
    expect(isGuestLoop({ kind: "guest" })).toBe(false);
    expect(Object.isFrozen(loop)).toBe(true);
    expect(Object.isFrozen(loop.definition.configSchema)).toBe(true);
    expect(JSON.parse(JSON.stringify(loop.definition))).toEqual({
      id: "greeter",
      configSchema: schema,
      runAs: "app",
    });
    expect(() =>
      defineLoop({ id: "bad", runAs: "owner" } as never, () => undefined),
    ).toThrow("runAs must be app or requester");
  });

  it("resolves runAs per operation, then per Bond, then for the Loop", () => {
    const triage = defineLoop(
      {
        id: "bug-triage",
        runAs: "app",
        requiredBonds: [
          {
            provider: "gitlab",
            operations: ["fetch", "read"],
            runAs: "requester",
          },
          {
            provider: "feishu",
            operations: ["im_read", "im_send"],
            runAs: { im_read: "requester" },
          },
        ],
      },
      () => undefined,
    );
    const d = triage.definition;
    expect(loopRunAs(d, "gitlab", "fetch")).toBe("requester");
    expect(loopRunAs(d, "feishu", "im_read")).toBe("requester");
    expect(loopRunAs(d, "feishu", "im_send")).toBe("app");
    expect(loopRunAs(d, "linear", "comment")).toBe("app");
    expect(loopRunAs({}, "gitlab", "fetch")).toBe("app");
    expect(loopRunAs({ runAs: "requester" }, "gitlab", "fetch")).toBe(
      "requester",
    );
    expect(JSON.parse(JSON.stringify(d.requiredBonds))).toEqual(
      d.requiredBonds,
    );
    expect(Object.isFrozen(d.requiredBonds![1]!.runAs)).toBe(true);

    const bad = (requiredBonds: unknown) => () =>
      defineLoop({ id: "bad", requiredBonds } as never, () => undefined);
    expect(
      bad([{ provider: "gitlab", operations: ["fetch"], runAs: "owner" }]),
    ).toThrow("gitlab.runAs must be app, requester, or a map");
    expect(
      bad([
        { provider: "gitlab", operations: ["fetch"], runAs: { push: "app" } },
      ]),
    ).toThrow("names push, which is not in its operations");
    expect(
      bad([
        {
          provider: "gitlab",
          operations: ["fetch"],
          runAs: { fetch: "owner" },
        },
      ]),
    ).toThrow("gitlab.runAs.fetch must be app or requester");
    expect(
      bad([{ provider: "gitlab", operations: ["fetch"], principal: "app" }]),
    ).toThrow("each requiredBonds entry needs");
  });

  it("validates configuration and passes the resolved config to install and handlers", async () => {
    const seen: unknown[] = [];
    const loop = defineLoop(
      { id: "greeter", configSchema: schema },
      (app, ctx) => {
        seen.push(["install", ctx.config]);
        app.on(["chat.message.received", "chat.message.edited"], (work) => {
          seen.push(["handle", work.event.type, work.config]);
          return work.react.none(`${String(work.config.greeting)}`);
        });
      },
    );

    expect(() => loadLoop(loop)).toThrow(
      "Invalid configuration for Loop greeter",
    );
    expect(() => loadLoop(loop, { agentId: "a", extra: true })).toThrow(
      TypeError,
    );

    const loaded = loadLoop(loop, { agentId: "worker" });
    expect(loaded.eventTypes).toEqual([
      "chat.message.received",
      "chat.message.edited",
    ]);
    expect(loaded.config).toEqual({ greeting: "hello", agentId: "worker" });

    const { host } = recordingHost();
    await expect(
      loaded.handle(event("chat.message.edited"), host),
    ).resolves.toEqual({
      status: "completed",
      effects: [],
      reason: "hello",
    });
    expect(seen).toEqual([
      ["install", { greeting: "hello", agentId: "worker" }],
      [
        "handle",
        "chat.message.edited",
        { greeting: "hello", agentId: "worker" },
      ],
    ]);
  });

  it("routes context, effects, and agent calls through the host capabilities", async () => {
    const loop = defineLoop({ id: "replier" }, (app) =>
      app.on("chat.message.received", async (work) => {
        const context = await work.context.project({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [
            work.context.event(),
            work.context.value({
              id: "note-1",
              kind: "note",
              value: "remember",
              provenance: [{ sourceType: "loop", sourceId: "replier" }],
            }),
          ],
          grants: ["chat.message.reply"],
        });
        const ack = await work.acknowledge(context, {
          integrationId: "chat",
          operation: "reaction.add",
          input: { emoji: "OnIt" },
        });
        if (ack.status !== "delivered") throw new Error("ack not delivered");
        const session = work.agent("worker").session({
          scopeId: "scope-1",
          workThreadId: "thread-1",
          privacyPartition: "team",
        });
        const turn = await session.turn({ context });
        await session.cancel();
        const reply = await work.effect(context, {
          integrationId: "chat",
          operation: "message.reply",
          input: { text: turn.output ?? null },
        });
        return work.react.effects([reply], "replied");
      }),
    );

    const { host, calls } = recordingHost();
    const result = await loadLoop(loop).handle(event(), host);

    expect(result).toEqual({
      status: "completed",
      effects: [effect],
      reason: "replied",
    });
    const binding = {
      scopeId: "scope-1",
      workThreadId: "thread-1",
      privacyPartition: "team",
    };
    expect(calls).toEqual([
      [
        "projectContext",
        {
          scopeId: "scope-1",
          workThreadId: "thread-1",
          items: [
            {
              id: "event-1",
              kind: "event",
              value: event(),
              provenance: [
                {
                  sourceType: "work-event",
                  sourceId: "event-1",
                  integrationId: "chat",
                },
              ],
            },
            {
              id: "note-1",
              kind: "note",
              value: "remember",
              provenance: [{ sourceType: "loop", sourceId: "replier" }],
            },
          ],
          grants: ["chat.message.reply"],
        },
      ],
      [
        "acknowledge",
        "context-1",
        {
          integrationId: "chat",
          operation: "reaction.add",
          input: { emoji: "OnIt" },
        },
      ],
      ["agentTurn", "worker", binding, "context-1"],
      ["agentCancel", "worker", binding],
      [
        "createEffect",
        "context-1",
        {
          integrationId: "chat",
          operation: "message.reply",
          input: { text: "reply" },
        },
      ],
    ]);
  });

  it("refuses Loops without handlers, unknown Event types, and non-draft results", async () => {
    expect(() =>
      loadLoop(defineLoop({ id: "empty" }, () => undefined)),
    ).toThrow("Loop empty registers no handlers");
    expect(() => loadLoop({ kind: "guest" } as never)).toThrow(
      "loadLoop expects a Loop from @openma/matter-loop",
    );

    const loop = defineLoop({ id: "broken" }, (app) =>
      app.on("chat.message.received", () => ({ status: "done" }) as never),
    );
    const loaded = loadLoop(loop);
    const { host } = recordingHost();
    await expect(loaded.handle(event("other.type"), host)).rejects.toThrow(
      "Loop broken has no handler for other.type",
    );
    await expect(loaded.handle(event(), host)).rejects.toThrow(
      "Loop broken returned something other than a Reaction draft",
    );
  });

  it("gives value items a fresh id when none is supplied", async () => {
    const ids: string[] = [];
    const loop = defineLoop({ id: "ids" }, (app) =>
      app.on("chat.message.received", (work) => {
        for (let i = 0; i < 2; i += 1) {
          ids.push(
            work.context.value({ kind: "note", value: i, provenance: [] }).id,
          );
        }
        return work.react.none();
      }),
    );
    await loadLoop(loop).handle(event(), recordingHost().host);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("has no dependencies: every import in src is package-relative", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
    const pkg = JSON.parse(
      readFileSync(join(src, "../package.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.peerDependencies).toBeUndefined();

    const specifiers = readdirSync(src)
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) =>
        [
          ...readFileSync(join(src, file), "utf8").matchAll(
            /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g,
          ),
        ].map((match) => match[1]),
      );
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s?.startsWith("./"))).toEqual([]);
  });
});

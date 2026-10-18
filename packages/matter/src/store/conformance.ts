import { createOpenMAEvent, type OpenMAEvent } from "../agent/index.js";
import type { Reaction, Turn, WorkEffect, WorkEvent } from "../index.js";
import { Effect, Either } from "effect";
import type { OpenMatterStore } from "./index.js";

/**
 * One conformance case. Framework-neutral: run each `run()` inside your test
 * runner. A case throws on failure.
 */
export interface StoreConformanceCase {
  readonly name: string;
  readonly run: () => Promise<void>;
}

export interface StoreConformanceOptions {
  /** Returns a fresh, empty store for each case. */
  readonly makeStore: () => OpenMatterStore | Promise<OpenMatterStore>;
  /**
   * Lease lifetime used by expiry cases. The suite waits slightly longer, so
   * the store's own clock decides expiry. Default 250 ms.
   */
  readonly shortLeaseMs?: number;
}

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(`OpenMatterStore conformance: ${message}`);
};
const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect);
const fails = async (effect: Effect.Effect<unknown, unknown>) =>
  Either.isLeft(await Effect.runPromise(Effect.either(effect)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LONG = 60_000;

const workEvent = (id: string): WorkEvent => ({
  schemaVersion: "0.1",
  id,
  type: "chat.message.received",
  occurredAt: "2026-08-20T08:00:00.000Z",
  receivedAt: "2026-08-20T08:00:01.000Z",
  idempotencyKey: `chat:${id}`,
  source: { provider: "chat", authority: "workspace-1" },
});

const reaction = (eventId: string, over: Partial<Reaction> = {}): Reaction => ({
  schemaVersion: "0.1",
  id: `reaction-${eventId}`,
  eventId,
  status: "completed",
  effects: [],
  createdAt: "2026-08-20T08:00:02.000Z",
  ...over,
});

const agentEvent = (
  turnId: string,
  seq: number,
  over: {
    readonly event_id?: string;
    readonly type?: "agent.message" | "turn.completed";
    readonly data?: Record<string, unknown>;
  } = {},
): OpenMAEvent =>
  createOpenMAEvent({
    event_id: over.event_id ?? `agent-event-${turnId}-${seq}`,
    session_id: "session-1",
    turn_id: turnId,
    seq,
    type: over.type ?? "agent.message",
    occurred_at: "2026-08-20T08:00:03.000Z",
    source: { kind: "harness", harness: "conformance" },
    data: over.data ?? { text: `message ${seq}` },
  }) as OpenMAEvent;

/**
 * The durability contract every OpenMatterStore adapter must meet, written
 * against the port only. Run it against the real adapter and database.
 * Expiry cases use real time, so adapters keep their authoritative clock.
 */
export const storeConformanceCases = (
  options: StoreConformanceOptions,
): readonly StoreConformanceCase[] => {
  const short = options.shortLeaseMs ?? 250;
  const expire = () => sleep(short * 2 + 20);
  const fresh = () => Promise.resolve(options.makeStore());

  return [
    {
      name: "an event lease is exclusive while it is live",
      run: async () => {
        const store = await fresh();
        const event = workEvent("event-exclusive");
        const first = await run(
          store.claimEvent(event, { ownerId: "w1", durationMs: LONG }),
        );
        assert(first._tag === "Acquired", "first claim is Acquired");
        const second = await run(
          store.claimEvent(event, { ownerId: "w2", durationMs: LONG }),
        );
        assert(second._tag === "Busy", "a live lease reports Busy");
      },
    },
    {
      name: "an expired event lease is taken over with a new token and the stale token is fenced",
      run: async () => {
        const store = await fresh();
        const event = workEvent("event-takeover");
        const first = await run(
          store.claimEvent(event, { ownerId: "w1", durationMs: short }),
        );
        assert(first._tag === "Acquired", "first claim is Acquired");
        if (first._tag !== "Acquired") return;
        await expire();
        const second = await run(
          store.claimEvent(event, { ownerId: "w2", durationMs: LONG }),
        );
        assert(second._tag === "Acquired", "an expired lease is reclaimed");
        if (second._tag !== "Acquired") return;
        assert(
          second.lease.token !== first.lease.token,
          "the reclaimed lease has a new token",
        );
        assert(
          await fails(
            store.commitTerminalReaction(reaction(event.id), first.lease.token),
          ),
          "a stale token cannot commit a terminal reaction",
        );
        assert(
          await fails(
            store.renewEventLease(event.id, first.lease.token, {
              durationMs: LONG,
            }),
          ),
          "a stale token cannot renew",
        );
        const committed = await run(
          store.commitTerminalReaction(reaction(event.id), second.lease.token),
        );
        assert(committed._tag === "Committed", "the current token commits");
      },
    },
    {
      name: "exactly one terminal reaction is committed per event",
      run: async () => {
        const store = await fresh();
        const event = workEvent("event-terminal");
        const claim = await run(
          store.claimEvent(event, { ownerId: "w1", durationMs: LONG }),
        );
        assert(claim._tag === "Acquired", "claim is Acquired");
        if (claim._tag !== "Acquired") return;
        const completed = reaction(event.id);
        const first = await run(
          store.commitTerminalReaction(completed, claim.lease.token),
        );
        assert(first._tag === "Committed", "first commit is Committed");
        const late = await run(
          store.commitTerminalReaction(
            reaction(event.id, { id: "reaction-late", status: "cancelled" }),
            claim.lease.token,
          ),
        );
        assert(
          late._tag === "Existing" &&
            late.reaction.id === completed.id &&
            late.reaction.status === "completed",
          "a later commit returns the existing reaction",
        );
        (completed as { status: string }).status = "cancelled";
        const receipt = await run(store.getReceipt(event.id));
        assert(
          receipt?.reaction.status === "completed",
          "the stored reaction is a copy, unaffected by later mutation",
        );
        const again = await run(
          store.claimEvent(event, { ownerId: "w2", durationMs: LONG }),
        );
        assert(
          again._tag === "Terminal" &&
            again.receipt.reaction.id === completed.id,
          "claiming a terminal event returns its receipt",
        );
      },
    },
    {
      name: "committed effects are claimed by an independent worker until delivered",
      run: async () => {
        const store = await fresh();
        const event = workEvent("event-effects");
        const claim = await run(
          store.claimEvent(event, { ownerId: "w1", durationMs: LONG }),
        );
        if (claim._tag !== "Acquired") throw new Error("claim is Acquired");
        const effect: WorkEffect = {
          schemaVersion: "0.1",
          id: "effect-1",
          eventId: event.id,
          integrationId: "chat",
          operation: "message.reply",
          idempotencyKey: "chat:event-effects:effect:1",
          input: { text: "hello" },
        };
        await run(
          store.commitTerminalReaction(
            reaction(event.id, { effects: [effect] }),
            claim.lease.token,
          ),
        );
        const pending = await run(
          store.claimPendingEffects({
            ownerId: "delivery",
            durationMs: LONG,
            limit: 10,
          }),
        );
        assert(
          pending.length === 1 &&
            pending[0]!.effect.id === effect.id &&
            pending[0]!.attempt === 1 &&
            pending[0]!.lease.ownerId === "delivery",
          "one pending effect is claimed with attempt 1",
        );
        const concurrent = await run(
          store.claimPendingEffects({
            ownerId: "other",
            durationMs: LONG,
            limit: 10,
          }),
        );
        assert(concurrent.length === 0, "a leased effect is not claimed twice");
        await run(
          store.recordDelivery(
            {
              effectId: effect.id,
              integrationId: "chat",
              operation: "message.reply",
              status: "delivered",
              attempt: 1,
              attemptedAt: "2026-08-20T08:00:04.000Z",
            },
            pending[0]!.lease.token,
          ),
        );
        const receipt = await run(store.getReceipt(event.id));
        assert(
          receipt?.deliveries.some(
            (d) => d.effectId === effect.id && d.status === "delivered",
          ),
          "the receipt records the delivery",
        );
        await expire();
        const after = await run(
          store.claimPendingEffects({
            ownerId: "later",
            durationMs: LONG,
            limit: 10,
          }),
        );
        assert(after.length === 0, "a delivered effect is never claimed again");
      },
    },
    {
      name: "a Session binding has one holder and is handed over on release",
      run: async () => {
        const store = await fresh();
        const first = await run(
          store.claimSession("binding-release", {
            ownerId: "w1",
            durationMs: LONG,
          }),
        );
        assert(first._tag === "Acquired", "first claim is Acquired");
        if (first._tag !== "Acquired") return;
        const busy = await run(
          store.claimSession("binding-release", {
            ownerId: "w2",
            durationMs: LONG,
          }),
        );
        assert(busy._tag === "Busy", "a live Session lease reports Busy");
        await run(store.releaseSession("binding-release", first.lease.token));
        const next = await run(
          store.claimSession("binding-release", {
            ownerId: "w2",
            durationMs: LONG,
          }),
        );
        assert(next._tag === "Acquired", "a released binding can be claimed");
      },
    },
    {
      name: "Turn and Agent event writes are fenced by the Session lease, and a terminal event wins",
      run: async () => {
        const store = await fresh();
        const first = await run(
          store.claimSession("binding-fence", {
            ownerId: "w1",
            durationMs: short,
          }),
        );
        if (first._tag !== "Acquired") throw new Error("claim is Acquired");
        await expire();
        const second = await run(
          store.claimSession("binding-fence", {
            ownerId: "w2",
            durationMs: LONG,
          }),
        );
        assert(
          second._tag === "Acquired",
          "an expired Session lease is reclaimed",
        );
        if (second._tag !== "Acquired") return;
        await run(
          store.saveSession(
            {
              id: "session-1",
              bindingKey: "binding-fence",
              agentId: "agent-1",
              authority: "workspace-1",
              scopeId: "scope-1",
              workThreadId: "thread-1",
              privacyPartition: "default",
              driverId: "mock",
              generation: 1,
              state: "open",
              createdAt: "2026-08-20T08:00:01.000Z",
              lastUsedAt: "2026-08-20T08:00:01.000Z",
            },
            second.lease.token,
          ),
        );
        const turn: Turn = {
          id: "turn-fence",
          sessionId: "session-1",
          triggerEventId: "event-fence",
          contextProjectionId: "context-1",
          contextDigest: "digest-1",
          allow: [],
          state: "running",
          createdAt: "2026-08-20T08:00:02.000Z",
        };
        assert(
          await fails(store.saveTurn(turn, "binding-fence", first.lease.token)),
          "a stale Session token cannot save a Turn",
        );
        await run(store.saveTurn(turn, "binding-fence", second.lease.token));
        const message = agentEvent(turn.id, 1);
        assert(
          await fails(
            store.appendAgentEvent(message, "binding-fence", first.lease.token),
          ),
          "a stale Session token cannot append an Agent event",
        );
        await run(
          store.appendAgentEvent(message, "binding-fence", second.lease.token),
        );
        await run(
          store.appendAgentEvent(message, "binding-fence", second.lease.token),
        );
        assert(
          await fails(
            store.appendAgentEvent(
              agentEvent(turn.id, 1, {
                event_id: "agent-event-conflict",
                data: { text: "other" },
              }),
              "binding-fence",
              second.lease.token,
            ),
          ),
          "a different event at the same sequence is rejected",
        );
        await run(
          store.appendAgentEvent(
            agentEvent(turn.id, 2, { type: "turn.completed", data: {} }),
            "binding-fence",
            second.lease.token,
          ),
        );
        const events = await run(store.getAgentEvents(turn.id));
        assert(events.length === 2, "a replayed Agent event is stored once");
        await run(
          store.saveTurn(
            {
              ...turn,
              state: "completed",
              completedAt: "2026-08-20T08:00:05.000Z",
            },
            "binding-fence",
            second.lease.token,
          ),
        );
        await run(
          store.saveTurn(
            {
              ...turn,
              state: "cancelled",
              completedAt: "2026-08-20T08:00:06.000Z",
            },
            "binding-fence",
            second.lease.token,
          ),
        );
        const stored = await run(store.getTurn(turn.id));
        assert(
          stored?.state === "completed",
          "a late cancellation does not overwrite a terminal Turn",
        );
      },
    },
    {
      name: "an operation call is begun once, completed once, and fenced by the Session lease",
      run: async () => {
        const store = await fresh();
        const first = await run(
          store.claimSession("binding-call", {
            ownerId: "w1",
            durationMs: short,
          }),
        );
        if (first._tag !== "Acquired") throw new Error("claim is Acquired");
        await expire();
        const second = await run(
          store.claimSession("binding-call", {
            ownerId: "w2",
            durationMs: LONG,
          }),
        );
        if (second._tag !== "Acquired") throw new Error("claim is Acquired");
        const token = second.lease.token;
        await run(
          store.saveSession(
            {
              id: "session-call",
              bindingKey: "binding-call",
              agentId: "agent-1",
              authority: "workspace-1",
              scopeId: "scope-1",
              workThreadId: "thread-1",
              privacyPartition: "default",
              driverId: "mock",
              generation: 1,
              state: "open",
              createdAt: "2026-08-20T08:00:01.000Z",
              lastUsedAt: "2026-08-20T08:00:01.000Z",
            },
            token,
          ),
        );
        await run(
          store.saveTurn(
            {
              id: "turn-call",
              sessionId: "session-call",
              triggerEventId: "event-call",
              contextProjectionId: "context-1",
              contextDigest: "digest-1",
              allow: ["chat.reply"],
              state: "running",
              createdAt: "2026-08-20T08:00:02.000Z",
            },
            "binding-call",
            token,
          ),
        );
        const call = {
          turnId: "turn-call",
          callId: "call-1",
          fingerprint: "fp-1",
          integrationId: "chat",
          operation: "reply",
          input: { text: "hi" },
          state: "pending" as const,
          startedAt: "2026-08-20T08:00:03.000Z",
        };
        assert(
          await fails(
            store.beginOperationCall(call, "binding-call", first.lease.token),
          ),
          "a stale Session token cannot begin an operation call",
        );
        assert(
          (await run(store.getOperationCall("turn-call", "call-1"))) ===
            undefined,
          "a fenced begin stores nothing",
        );
        await run(store.beginOperationCall(call, "binding-call", token));
        const again = await run(
          store.beginOperationCall(
            { ...call, startedAt: "2026-08-20T08:00:09.000Z" },
            "binding-call",
            token,
          ),
        );
        assert(
          again.startedAt === call.startedAt && again.state === "pending",
          "a second begin returns the first call",
        );
        const delivered = { status: "delivered" as const, receipt: { id: 1 } };
        assert(
          await fails(
            store.completeOperationCall(
              "turn-call",
              "call-1",
              delivered,
              "2026-08-20T08:00:04.000Z",
              "binding-call",
              first.lease.token,
            ),
          ),
          "a stale Session token cannot complete an operation call",
        );
        const completed = await run(
          store.completeOperationCall(
            "turn-call",
            "call-1",
            delivered,
            "2026-08-20T08:00:04.000Z",
            "binding-call",
            token,
          ),
        );
        assert(
          completed.state === "completed" &&
            completed.result?.status === "delivered" &&
            completed.completedAt === "2026-08-20T08:00:04.000Z",
          "a pending call is completed with its result",
        );
        const late = await run(
          store.completeOperationCall(
            "turn-call",
            "call-1",
            { status: "uncertain", reason: "late" },
            "2026-08-20T08:00:05.000Z",
            "binding-call",
            token,
          ),
        );
        assert(
          late.result?.status === "delivered",
          "a completed call is not overwritten",
        );
        assert(
          await fails(
            store.completeOperationCall(
              "turn-call",
              "call-unknown",
              delivered,
              "2026-08-20T08:00:05.000Z",
              "binding-call",
              token,
            ),
          ),
          "completing an unknown call fails",
        );
        const stored = await run(store.getOperationCall("turn-call", "call-1"));
        assert(
          stored?.state === "completed" &&
            JSON.stringify(stored.input) === JSON.stringify({ text: "hi" }),
          "the call is stored with its input",
        );
      },
    },
  ];
};

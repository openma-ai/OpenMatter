import { createOpenMAEvent, type OpenMAEvent } from "@openmatter/agent";
import type { Reaction, Turn, WorkEffect } from "@openmatter/core";
import { makeMemoryStore } from "@openmatter/store-memory";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

const event = {
  schemaVersion: "0.1",
  id: "event-lease-1",
  type: "chat.message.received",
  occurredAt: "2026-08-20T08:00:00.000Z",
  receivedAt: "2026-08-20T08:00:01.000Z",
  idempotencyKey: "chat:event-lease-1",
  source: { provider: "chat", authority: "workspace-1" },
} as const;

describe("memory store durability contract", () => {
  it("uses the Store clock as the authority for lease expiry", async () => {
    let storeNow = "2026-08-20T08:00:00.000Z";
    const store = makeMemoryStore({ clock: () => storeNow });

    const first = await Effect.runPromise(
      store.claimEvent(event, {
        ownerId: "worker-1",
        durationMs: 60_000,
      }),
    );
    if (first._tag !== "Acquired") throw new Error("expected event claim");
    expect(first.lease.expiresAt).toBe("2026-08-20T08:01:00.000Z");

    storeNow = "2026-08-20T08:01:00.000Z";
    const reclaimed = await Effect.runPromise(
      store.claimEvent(event, {
        ownerId: "worker-2",
        durationMs: 60_000,
      }),
    );
    expect(reclaimed._tag).toBe("Acquired");
    if (reclaimed._tag !== "Acquired") return;
    expect(reclaimed.lease.expiresAt).toBe("2026-08-20T08:02:00.000Z");
  });

  it("fences a stale event worker after its lease is reclaimed", async () => {
    let storeNow = "2026-08-20T08:00:00.000Z";
    const store = makeMemoryStore({ clock: () => storeNow });
    const first = await Effect.runPromise(
      store.claimEvent(event, {
        ownerId: "worker-1",
        durationMs: 60_000,
      }),
    );
    storeNow = "2026-08-20T08:02:00.000Z";
    const reclaimed = await Effect.runPromise(
      store.claimEvent(event, {
        ownerId: "worker-2",
        durationMs: 60_000,
      }),
    );
    expect(first._tag).toBe("Acquired");
    expect(reclaimed._tag).toBe("Acquired");
    if (first._tag !== "Acquired" || reclaimed._tag !== "Acquired") return;
    expect(reclaimed.lease.token).not.toBe(first.lease.token);

    const staleReaction: Reaction = {
      schemaVersion: "0.1",
      id: "reaction-stale",
      eventId: event.id,
      status: "completed",
      effects: [],
      createdAt: "2026-08-20T08:02:01.000Z",
    };
    await expect(
      Effect.runPromise(
        store.commitTerminalReaction(staleReaction, first.lease.token),
      ),
    ).rejects.toThrow("event lease");
  });

  it("commits exactly one terminal reaction for an event lease", async () => {
    const store = makeMemoryStore({
      clock: () => "2026-08-20T08:00:00.000Z",
    });
    const claim = await Effect.runPromise(
      store.claimEvent(event, {
        ownerId: "worker-1",
        durationMs: 60_000,
      }),
    );
    if (claim._tag !== "Acquired") throw new Error("expected event claim");
    const completed: Reaction = {
      schemaVersion: "0.1",
      id: "reaction-completed",
      eventId: event.id,
      status: "completed",
      effects: [],
      createdAt: "2026-08-20T08:00:01.000Z",
    };
    const cancelled: Reaction = {
      ...completed,
      id: "reaction-cancelled",
      status: "cancelled",
      createdAt: "2026-08-20T08:00:02.000Z",
    };

    const first = await Effect.runPromise(
      store.commitTerminalReaction(completed, claim.lease.token),
    );
    const lateCancellation = await Effect.runPromise(
      store.commitTerminalReaction(cancelled, claim.lease.token),
    );

    expect(first).toEqual({ _tag: "Committed", reaction: completed });
    expect(lateCancellation).toEqual({
      _tag: "Existing",
      reaction: completed,
    });
    (completed as { status: string }).status = "cancelled";
    (first.reaction as { reason?: string }).reason = "mutated after commit";
    expect((await Effect.runPromise(store.inspect)).reactions).toEqual([
      expect.objectContaining({
        id: "reaction-completed",
        status: "completed",
      }),
    ]);
    expect(
      (await Effect.runPromise(store.inspect)).reactions[0],
    ).not.toHaveProperty("reason");
  });

  it("claims committed effect intents for independent outbox recovery", async () => {
    let storeNow = "2026-08-20T08:00:00.000Z";
    const store = makeMemoryStore({ clock: () => storeNow });
    const claim = await Effect.runPromise(
      store.claimEvent(event, {
        ownerId: "worker-1",
        durationMs: 60_000,
      }),
    );
    if (claim._tag !== "Acquired") throw new Error("expected event claim");
    const effect: WorkEffect = {
      schemaVersion: "0.1",
      id: "effect-pending-1",
      eventId: event.id,
      integrationId: "chat",
      operation: "message.reply",
      idempotencyKey: "chat:event-lease-1:effect:1",
      input: { text: "hello" },
    };
    await Effect.runPromise(
      store.commitTerminalReaction(
        {
          schemaVersion: "0.1",
          id: "reaction-1",
          eventId: event.id,
          status: "completed",
          effects: [effect],
          createdAt: "2026-08-20T08:00:01.000Z",
        },
        claim.lease.token,
      ),
    );

    storeNow = "2026-08-20T08:00:02.000Z";
    const pending = await Effect.runPromise(
      store.claimPendingEffects({
        ownerId: "delivery-worker",
        durationMs: 60_000,
        limit: 10,
      }),
    );

    expect(pending).toEqual([
      expect.objectContaining({
        effect,
        attempt: 1,
        lease: expect.objectContaining({ ownerId: "delivery-worker" }),
      }),
    ]);
  });

  it("serializes workers competing for the same agent session binding", async () => {
    let storeNow = "2026-08-20T08:00:00.000Z";
    const store = makeMemoryStore({ clock: () => storeNow });
    const first = await Effect.runPromise(
      store.claimSession("binding-1", {
        ownerId: "worker-1",
        durationMs: 60_000,
      }),
    );
    storeNow = "2026-08-20T08:00:10.000Z";
    const concurrent = await Effect.runPromise(
      store.claimSession("binding-1", {
        ownerId: "worker-2",
        durationMs: 60_000,
      }),
    );

    expect(first._tag).toBe("Acquired");
    expect(concurrent._tag).toBe("Busy");
  });

  it("fences Turn and Agent event writes with the Session lease", async () => {
    let storeNow = "2026-08-20T08:00:00.000Z";
    const store = makeMemoryStore({ clock: () => storeNow });
    const first = await Effect.runPromise(
      store.claimSession("binding-1", {
        ownerId: "worker-1",
        durationMs: 60_000,
      }),
    );
    storeNow = "2026-08-20T08:02:00.000Z";
    const reclaimed = await Effect.runPromise(
      store.claimSession("binding-1", {
        ownerId: "worker-2",
        durationMs: 60_000,
      }),
    );
    if (first._tag !== "Acquired" || reclaimed._tag !== "Acquired") {
      throw new Error("expected Session claims");
    }
    const turn: Turn = {
      id: "turn-stable",
      sessionId: "session-1",
      triggerEventId: event.id,
      contextProjectionId: "context-1",
      contextDigest: "digest-1",
      allow: [],
      state: "running",
      createdAt: "2026-08-20T08:02:01.000Z",
    };

    await expect(
      Effect.runPromise(store.saveTurn(turn, "binding-1", first.lease.token)),
    ).rejects.toThrow("session lease");

    await Effect.runPromise(
      store.saveTurn(turn, "binding-1", reclaimed.lease.token),
    );
    const firstEvent: OpenMAEvent = createOpenMAEvent({
      event_id: "agent-event-1",
      session_id: "session-1",
      turn_id: turn.id,
      seq: 1,
      type: "agent.message",
      occurred_at: "2026-08-20T08:02:02.000Z",
      source: { kind: "harness", harness: "test" },
      data: { text: "first" },
    });
    await Effect.runPromise(
      store.appendAgentEvent(firstEvent, "binding-1", reclaimed.lease.token),
    );
    await expect(
      Effect.runPromise(
        store.appendAgentEvent(
          createOpenMAEvent({
            event_id: "agent-event-conflict",
            session_id: firstEvent.session_id,
            turn_id: firstEvent.turn_id!,
            seq: firstEvent.seq!,
            type: "agent.message",
            occurred_at: firstEvent.occurred_at,
            source: firstEvent.source,
            data: { text: "other" },
          }),
          "binding-1",
          reclaimed.lease.token,
        ),
      ),
    ).rejects.toThrow("Conflicting Agent event");

    const terminalEvent: OpenMAEvent = createOpenMAEvent({
      event_id: "agent-event-terminal",
      session_id: firstEvent.session_id,
      turn_id: firstEvent.turn_id!,
      seq: 2,
      type: "turn.completed",
      occurred_at: firstEvent.occurred_at,
      source: firstEvent.source,
      data: {},
    });
    await Effect.runPromise(
      store.appendAgentEvent(terminalEvent, "binding-1", reclaimed.lease.token),
    );
    await Effect.runPromise(
      store.saveTurn(
        {
          ...turn,
          state: "completed",
          completedAt: "2026-08-20T08:02:03.000Z",
        },
        "binding-1",
        reclaimed.lease.token,
      ),
    );
    await Effect.runPromise(
      store.saveTurn(
        {
          ...turn,
          state: "cancelled",
          completedAt: "2026-08-20T08:02:04.000Z",
        },
        "binding-1",
        reclaimed.lease.token,
      ),
    );
    expect((await Effect.runPromise(store.inspect)).turns).toEqual([
      expect.objectContaining({ state: "completed" }),
    ]);
  });
});

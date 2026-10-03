import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Reaction, WorkEvent } from "@openmatter/core";
import { makeMemoryStore } from "@openmatter/store-memory";
import type { OpenMatterStore } from "@openmatter/store";
import { makeSqliteStore, type SqliteStore } from "@openmatter/store-sqlite";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

const event = {
  schemaVersion: "0.1",
  id: "event-lease-1",
  type: "project.message",
  occurredAt: "2026-08-20T08:00:00.000Z",
  receivedAt: "2026-08-20T08:00:01.000Z",
  idempotencyKey: "project:event-lease-1",
  source: {
    provider: "project",
    authority: "project-host",
    conversationId: "project-1",
  },
} as const satisfies WorkEvent;

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const openSqlite = async () => {
  const dir = await mkdtemp(join(tmpdir(), "openmatter-store-"));
  directories.push(dir);
  return makeSqliteStore({ filename: join(dir, "store.db") });
};

const goalContract = (
  open: () => OpenMatterStore | Promise<OpenMatterStore>,
) => {
  it("replaces only a completed goal and fences stale revisions", async () => {
    const store = await open();
    const created = await Effect.runPromise(
      store.createThreadGoal({
        scopeId: "project-1",
        workThreadId: "thread-1",
        objective: "Ship the branch",
        tokenBudget: 10,
      }),
    );
    await expect(
      Effect.runPromise(
        store.createThreadGoal({
          scopeId: "project-1",
          workThreadId: "thread-1",
          objective: "Another goal",
        }),
      ),
    ).rejects.toThrow(/unfinished/);
    await expect(
      Effect.runPromise(
        store.updateThreadGoal("thread-1", {
          expectedGoalId: "other",
          expectedRevision: created.revision,
          status: "paused",
        }),
      ),
    ).rejects.toThrow(/Stale goal/);
    await expect(
      Effect.runPromise(
        store.updateThreadGoal("thread-1", {
          expectedGoalId: created.id,
          expectedRevision: created.revision + 1,
          status: "paused",
        }),
      ),
    ).rejects.toThrow(/revision/);

    const accounted = await Effect.runPromise(
      store.accountThreadGoal("thread-1", {
        goalId: created.id,
        turnId: "turn-1",
        tokensUsed: 10,
        timeUsedSeconds: 3,
      }),
    );
    expect(accounted.tokensUsed).toBe(10);
    expect(accounted.status).toBe("budget_limited");
    const paused = await Effect.runPromise(
      store.updateThreadGoal("thread-1", {
        expectedGoalId: created.id,
        expectedRevision: accounted.revision,
        status: "paused",
        reason: "waiting",
      }),
    );
    expect(paused.status).toBe("paused");
    expect(paused.revision).toBe(accounted.revision + 1);
    const replayed = await Effect.runPromise(
      store.accountThreadGoal("thread-1", {
        goalId: created.id,
        turnId: "turn-1",
        tokensUsed: 10,
        timeUsedSeconds: 3,
      }),
    );
    expect(replayed).toEqual(paused);
    await expect(
      Effect.runPromise(
        store.accountThreadGoal("thread-1", {
          goalId: created.id,
          turnId: "turn-1",
          tokensUsed: 4,
          timeUsedSeconds: 1,
        }),
      ),
    ).rejects.toThrow(/Conflicting/);

    const complete = await Effect.runPromise(
      store.updateThreadGoal("thread-1", {
        expectedGoalId: paused.id,
        expectedRevision: paused.revision,
        status: "complete",
      }),
    );
    const replaced = await Effect.runPromise(
      store.createThreadGoal({
        scopeId: "project-1",
        workThreadId: "thread-1",
        objective: "Next outcome",
      }),
    );
    expect(replaced.id).not.toBe(complete.id);
    expect(replaced.tokensUsed).toBe(0);
    expect(await Effect.runPromise(store.listThreadGoals("project-1"))).toEqual(
      [expect.objectContaining({ id: replaced.id })],
    );
  });
};

describe("memory store thread goals", () => {
  goalContract(() => makeMemoryStore());
});

describe("sqlite store", () => {
  goalContract(openSqlite);

  it("fences a stale event worker after its lease is reclaimed", async () => {
    const store = await openSqlite();
    const first = await Effect.runPromise(
      store.claimEvent(event, { ownerId: "worker-1", durationMs: 1 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reclaimed = await Effect.runPromise(
      store.claimEvent(event, { ownerId: "worker-2", durationMs: 60_000 }),
    );
    expect(first._tag).toBe("Acquired");
    expect(reclaimed._tag).toBe("Acquired");
    if (first._tag !== "Acquired" || reclaimed._tag !== "Acquired") return;
    const stale: Reaction = {
      schemaVersion: "0.1",
      id: "reaction-stale",
      eventId: event.id,
      status: "completed",
      effects: [],
      createdAt: "2026-08-20T08:02:01.000Z",
    };
    await expect(
      Effect.runPromise(store.commitTerminalReaction(stale, first.lease.token)),
    ).rejects.toThrow(/lease/);
    const committed = await Effect.runPromise(
      store.commitTerminalReaction(stale, reclaimed.lease.token),
    );
    expect(committed._tag).toBe("Committed");
  });

  it("reopens goals and cancellation intent from the same file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openmatter-store-"));
    directories.push(dir);
    const filename = join(dir, "store.db");
    const first = makeSqliteStore({ filename });
    const goal = await Effect.runPromise(
      first.createThreadGoal({
        scopeId: "project-1",
        workThreadId: "thread-1",
        objective: "Survive restart",
      }),
    );
    await Effect.runPromise(first.close);
    const reopened: SqliteStore = makeSqliteStore({ filename });
    expect(await Effect.runPromise(reopened.getThreadGoal("thread-1"))).toEqual(
      goal,
    );
    const scoped = await Effect.runPromise(reopened.inspectScope("project-1"));
    expect(scoped.goals).toEqual([goal]);
    expect(await Effect.runPromise(reopened.inspectScope("other"))).toEqual(
      expect.objectContaining({ goals: [] }),
    );
    await Effect.runPromise(reopened.close);
  });
});

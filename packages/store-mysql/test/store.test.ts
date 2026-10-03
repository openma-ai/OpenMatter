import { randomUUID } from "node:crypto";
import type { Reaction, WorkEvent } from "@openmatter/core";
import { Effect } from "effect";
import { createPool } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { makeMysqlStore } from "../src/index.js";

const mysqlUrl = process.env.PROJECT_WORKER_MYSQL_URL;

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

describe("mysql store", () => {
  it("runs the store port, reopens facts, and isolates tenants", async (ctx) => {
    if (!mysqlUrl) {
      ctx.skip("MySQL tests need PROJECT_WORKER_MYSQL_URL");
      return;
    }
    const pool = createPool(mysqlUrl);
    try {
      await pool.query("SELECT 1");
    } catch (error) {
      await pool.end();
      ctx.skip(
        `MySQL tests skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const tenant = randomUUID();
    const other = randomUUID();
    const store = makeMysqlStore({ pool, tenantId: tenant });
    const created = await Effect.runPromise(
      store.createThreadGoal({
        scopeId: "project-1",
        workThreadId: "thread-1",
        objective: "Ship",
        tokenBudget: 4,
      }),
    );
    await expect(
      Effect.runPromise(
        store.updateThreadGoal("thread-1", {
          expectedGoalId: created.id,
          expectedRevision: created.revision + 3,
          status: "paused",
        }),
      ),
    ).rejects.toThrow(/revision/);
    const first = await Effect.runPromise(
      store.claimEvent(event, { ownerId: "worker-1", durationMs: 1 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
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
    await Effect.runPromise(store.close);
    const reopened = makeMysqlStore({ pool, tenantId: tenant });
    expect(
      (await Effect.runPromise(reopened.getThreadGoal("thread-1")))?.id,
    ).toBe(created.id);
    const foreign = makeMysqlStore({ pool, tenantId: other });
    expect(
      await Effect.runPromise(foreign.getThreadGoal("thread-1")),
    ).toBeUndefined();
    expect(
      (await Effect.runPromise(foreign.inspectScope("project-1"))).goals,
    ).toEqual([]);
    await Effect.runPromise(reopened.close);
    await Effect.runPromise(foreign.close);
    await pool.end();
  });
});

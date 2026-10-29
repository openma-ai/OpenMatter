import { createHash, randomUUID } from "node:crypto";
import type { Reaction, WorkEvent } from "@openma/matter";
import { Effect } from "effect";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { storeConformanceCases } from "@openma/matter/store";
import { afterAll, describe, expect, it } from "vitest";
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

describe("mysql store binding keys", () => {
  it("indexes a Session binding key by its digest and keeps the full key in the Session", async (ctx) => {
    if (!mysqlUrl) {
      ctx.skip("MySQL tests need PROJECT_WORKER_MYSQL_URL");
      return;
    }
    const pool = createPool(mysqlUrl);
    const tenant = randomUUID();
    const store = makeMysqlStore({ pool, tenantId: tenant });
    try {
      const key = JSON.stringify([
        "agent-1",
        "workspace-1",
        `chat:${"c".repeat(200)}`,
        `thread:${"t".repeat(60)}`,
        `chat:${"c".repeat(200)}`,
      ]);
      const digest = createHash("sha256").update(key, "utf8").digest("hex");
      const claim = await Effect.runPromise(
        store.claimSession(key, { ownerId: "w1", durationMs: 60_000 }),
      );
      if (claim._tag !== "Acquired") throw new Error("claim is Acquired");
      await Effect.runPromise(
        store.saveSession(
          {
            id: "session-digest",
            bindingKey: key,
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
          claim.lease.token,
        ),
      );
      const [leases] = await pool.query<RowDataPacket[]>(
        "SELECT id FROM openmatter_store_leases WHERE tenant_id=? AND kind='session'",
        [tenant],
      );
      const [bindings] = await pool.query<RowDataPacket[]>(
        "SELECT binding_key FROM openmatter_store_bindings WHERE tenant_id=?",
        [tenant],
      );
      const [records] = await pool.query<RowDataPacket[]>(
        "SELECT parent_id, data FROM openmatter_store_records WHERE tenant_id=? AND kind='session'",
        [tenant],
      );
      expect(leases.map((row) => row.id)).toEqual([digest]);
      expect(bindings.map((row) => row.binding_key)).toEqual([digest]);
      expect(records).toHaveLength(1);
      expect(records[0]!.parent_id).toBeNull();
      expect(JSON.parse(records[0]!.data as string).bindingKey).toBe(key);
      const found = await Effect.runPromise(store.getSessionBinding(key));
      expect(found.session?.id).toBe("session-digest");
      expect(found.lease).toMatchObject({ ownerId: "w1", held: true });
    } finally {
      await Effect.runPromise(store.close);
      await pool.end();
    }
  });
});

describe("mysql store conformance", () => {
  const pool = mysqlUrl ? createPool(mysqlUrl) : undefined;
  afterAll(async () => {
    await pool?.end();
  });
  // Each case gets its own tenant, so cases never see each other's rows.
  for (const c of storeConformanceCases({
    makeStore: () => makeMysqlStore({ pool: pool!, tenantId: randomUUID() }),
  })) {
    it(c.name, async (ctx) => {
      if (!pool) {
        ctx.skip("MySQL tests need PROJECT_WORKER_MYSQL_URL");
        return;
      }
      await c.run();
    });
  }
});

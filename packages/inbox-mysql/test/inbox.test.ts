import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { createPool, type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeMysqlInbox } from "../src/index.js";
import { inboxConformanceCases } from "@openma/matter/inbox";

// The same database the MySQL store tests use; unset, these tests skip.
const mysqlUrl = process.env.PROJECT_WORKER_MYSQL_URL;

const item = (id: string) => ({
  id,
  idempotencyKey: `test:${id}`,
  integrationId: "test",
  eventType: "message.received",
  body: { text: id },
  receivedAt: "2026-08-20T10:00:00.000Z",
});

let pools: Pool[] = [];
let available = false;

beforeAll(async () => {
  if (!mysqlUrl) return;
  const probe = createPool(mysqlUrl);
  try {
    await probe.query("SELECT 1");
    available = true;
  } catch {
    available = false;
  } finally {
    await probe.end();
  }
});

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
  pools = [];
});

const pool = () => {
  const created = createPool(mysqlUrl!);
  pools.push(created);
  return created;
};

const skipUnlessMysql = (ctx: { skip: (note?: string) => void }) => {
  if (!available) ctx.skip("MySQL tests need PROJECT_WORKER_MYSQL_URL");
};

describe("MySQL durable inbox", () => {
  const shared = { pool: undefined as Pool | undefined };
  for (const conformance of inboxConformanceCases({
    makeInbox: () => {
      shared.pool ??= pool();
      return makeMysqlInbox({ pool: shared.pool, tenantId: randomUUID() });
    },
  })) {
    it(`conforms: ${conformance.name}`, async (ctx) => {
      skipUnlessMysql(ctx);
      await conformance.run();
    });
  }

  it("lets two replicas share a partition without leasing an item twice", async (ctx) => {
    skipUnlessMysql(ctx);
    const tenantId = randomUUID();
    const a = makeMysqlInbox({ pool: pool(), tenantId });
    const b = makeMysqlInbox({ pool: pool(), tenantId });
    const ids = Array.from(
      { length: 40 },
      (_, i) => `item-${String(i).padStart(2, "0")}`,
    );
    // Both replicas receive every delivery; each item is stored once.
    const outcomes = await Promise.all(
      ids.flatMap((id) =>
        [a, b].map((inbox) => Effect.runPromise(inbox.enqueue(item(id)))),
      ),
    );
    expect(outcomes.filter((o) => o === "stored")).toHaveLength(ids.length);

    const claimed: string[] = [];
    const drain = async (inbox: typeof a, owner: string) => {
      for (;;) {
        const claims = await Effect.runPromise(
          inbox.claim({ ownerId: owner, durationMs: 60_000, limit: 3 }),
        );
        if (claims.length === 0) return;
        for (const claim of claims) {
          claimed.push(claim.item.id);
          await Effect.runPromise(
            inbox.complete(claim.item.id, claim.lease.token),
          );
        }
      }
    };
    await Promise.all([
      drain(a, "replica-a"),
      drain(b, "replica-b"),
      drain(a, "replica-a2"),
      drain(b, "replica-b2"),
    ]);
    expect([...claimed].sort()).toEqual(ids);
    await Effect.runPromise(a.close);
    await Effect.runPromise(b.close);
  });

  it("keeps partitions apart and survives a reopen", async (ctx) => {
    skipUnlessMysql(ctx);
    const shared = pool();
    const one = makeMysqlInbox({ pool: shared, tenantId: randomUUID() });
    const other = makeMysqlInbox({ pool: shared, tenantId: randomUUID() });
    expect(await Effect.runPromise(one.enqueue(item("same-id")))).toBe(
      "stored",
    );
    // The same id and key in another partition is a different item.
    expect(
      await Effect.runPromise(
        other.enqueue({ ...item("same-id"), body: { text: "other" } }),
      ),
    ).toBe("stored");
    const claims = await Effect.runPromise(
      other.claim({ ownerId: "o", durationMs: 60_000, limit: 10 }),
    );
    expect(claims.map((c) => c.item.body)).toEqual([{ text: "other" }]);
    // A lease token of one partition does not complete the other's item.
    await expect(
      Effect.runPromise(one.complete("same-id", claims[0]!.lease.token)),
    ).rejects.toThrow(/stale/);

    const tenantId = randomUUID();
    const before = makeMysqlInbox({ url: mysqlUrl!, tenantId });
    await Effect.runPromise(before.enqueue(item("durable")));
    await Effect.runPromise(before.close);
    await expect(
      Effect.runPromise(
        before.claim({ ownerId: "x", durationMs: 1000, limit: 1 }),
      ),
    ).rejects.toThrow(/closed/);
    const after = makeMysqlInbox({ url: mysqlUrl!, tenantId });
    const reopened = await Effect.runPromise(
      after.claim({ ownerId: "x", durationMs: 1000, limit: 5 }),
    );
    expect(reopened.map((c) => [c.item.id, c.attempt])).toEqual([
      ["durable", 1],
    ]);
    await Effect.runPromise(after.close);
  });

  it("refuses an invalid configuration", () => {
    expect(() => makeMysqlInbox({ tenantId: "", url: "mysql://x" })).toThrow(
      /tenantId/,
    );
    expect(() => makeMysqlInbox({ tenantId: "t" })).toThrow(/exactly one/);
  });
});

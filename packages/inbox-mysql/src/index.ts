import { randomUUID } from "node:crypto";
import {
  createPool,
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
import { JsonValueSchema, type JsonValue } from "@openma/matter";
import {
  InboxError,
  type DurableInbox,
  type InboxClaim,
  type InboxItem,
} from "@openma/matter/inbox";
import { Effect, Schema } from "effect";

export interface MysqlInboxOptions {
  /**
   * Partitions one table between inboxes, for example one per connection a
   * host runs. Items, idempotency keys and leases never cross partitions.
   */
  readonly tenantId: string;
  /** A `mysql://` URL; the inbox owns the pool it creates. */
  readonly url?: string;
  /** A pool the caller owns (and ends); `close` leaves it open. */
  readonly pool?: Pool;
  readonly makeLeaseToken?: () => string;
}

export interface MysqlInbox extends DurableInbox {
  readonly inspect: Effect.Effect<
    readonly { item: InboxItem; state: string; error: string | null }[],
    InboxError
  >;
  readonly close: Effect.Effect<void, InboxError>;
}

type JsonObject = { readonly [key: string]: JsonValue };

const canonicalize = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize((value as JsonObject)[key]!)]),
  );
};

const bodyJson = (body: JsonValue) => JSON.stringify(canonicalize(body));

const portableItem = (item: InboxItem): InboxItem => {
  if (
    item.id.length === 0 ||
    item.id.length > 191 ||
    item.idempotencyKey.length === 0 ||
    item.idempotencyKey.length > 191 ||
    item.integrationId.length === 0 ||
    item.eventType.length === 0 ||
    !Number.isFinite(Date.parse(item.receivedAt)) ||
    !Schema.is(JsonValueSchema)(item.body)
  ) {
    throw new InboxError({ message: "Invalid durable inbox item" });
  }
  return { ...item, body: structuredClone(item.body) };
};

const SCHEMA = `CREATE TABLE IF NOT EXISTS openmatter_inbox (
  tenant_id VARCHAR(191) NOT NULL,
  id VARCHAR(191) NOT NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  integration_id VARCHAR(191) NOT NULL,
  event_type VARCHAR(191) NOT NULL,
  body_json LONGTEXT NOT NULL,
  received_at VARCHAR(64) NOT NULL,
  state VARCHAR(16) NOT NULL,
  available_at_ms BIGINT NOT NULL,
  attempt INT NOT NULL DEFAULT 0,
  lease_token VARCHAR(191) NULL,
  lease_owner VARCHAR(191) NULL,
  lease_expires_at_ms BIGINT NULL,
  last_error TEXT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE KEY openmatter_inbox_idempotency (tenant_id, idempotency_key),
  KEY openmatter_inbox_claimable (tenant_id, state, available_at_ms, lease_expires_at_ms)
)`;

/** The database clock, so every replica agrees on lease expiry. */
const NOW_MS = "CAST(ROUND(UNIX_TIMESTAMP(NOW(3)) * 1000) AS SIGNED)";

const initialized = new WeakMap<Pool, Promise<void>>();

type Row = RowDataPacket & Record<string, unknown>;

const str = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") {
    throw new InboxError({ message: `Invalid MySQL inbox ${key}` });
  }
  return value;
};

const num = (row: Row, key: string): number => {
  const value = row[key];
  const numeric =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string"
        ? Number(value)
        : value;
  if (typeof numeric !== "number" || !Number.isSafeInteger(numeric)) {
    throw new InboxError({ message: `Invalid MySQL inbox ${key}` });
  }
  return numeric;
};

const rowToItem = (row: Row): InboxItem => {
  const parsed = JSON.parse(str(row, "body_json")) as unknown;
  if (!Schema.is(JsonValueSchema)(parsed)) {
    throw new InboxError({ message: "MySQL inbox body is not portable JSON" });
  }
  return {
    id: str(row, "id"),
    idempotencyKey: str(row, "idempotency_key"),
    integrationId: str(row, "integration_id"),
    eventType: str(row, "event_type"),
    body: parsed,
    receivedAt: str(row, "received_at"),
  };
};

/**
 * A DurableInbox in MySQL (or MariaDB 10.6+). Any number of host replicas
 * may share it: a claim locks the rows it takes with `FOR UPDATE SKIP
 * LOCKED`, so two replicas never lease the same item, and lease expiry uses
 * the database clock. Completed rows are kept for deduplication.
 */
export const makeMysqlInbox = (options: MysqlInboxOptions): MysqlInbox => {
  if (options.tenantId.length === 0 || options.tenantId.length > 191) {
    throw new InboxError({ message: "MySQL inbox tenantId is invalid" });
  }
  if ((options.url === undefined) === (options.pool === undefined)) {
    throw new InboxError({
      message: "MySQL inbox needs exactly one of url or pool",
    });
  }
  const ownsPool = options.pool === undefined;
  const pool = options.pool ?? createPool(options.url!);
  const tenant = options.tenantId;
  let closed = false;
  let leaseSequence = 0;

  const ready = (): Promise<void> => {
    let pending = initialized.get(pool);
    if (pending === undefined) {
      pending = pool.query(SCHEMA).then(() => undefined);
      pending.catch(() => initialized.delete(pool));
      initialized.set(pool, pending);
    }
    return pending;
  };

  const attempt = <A>(message: string, operation: () => Promise<A>) =>
    Effect.tryPromise({
      try: async () => {
        if (closed) throw new InboxError({ message: "MySQL inbox is closed" });
        await ready();
        return operation();
      },
      catch: (cause) =>
        cause instanceof InboxError
          ? cause
          : new InboxError({ message, cause }),
    });

  const transaction = async <A>(
    operation: (connection: PoolConnection) => Promise<A>,
  ): Promise<A> => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      try {
        const result = await operation(connection);
        await connection.commit();
        return result;
      } catch (cause) {
        await connection.rollback();
        throw cause;
      }
    } finally {
      connection.release();
    }
  };

  const changed = (result: unknown): number =>
    (result as ResultSetHeader).affectedRows;

  const stale = (itemId: string) =>
    new InboxError({ message: `Invalid or stale inbox lease for ${itemId}` });

  const enqueue: DurableInbox["enqueue"] = (input) =>
    attempt("Unable to enqueue durable inbox item", async () => {
      const item = portableItem(input);
      const canonicalBody = bodyJson(item.body);
      const [inserted] = await pool.query(
        `INSERT IGNORE INTO openmatter_inbox (
           tenant_id, id, idempotency_key, integration_id, event_type,
           body_json, received_at, state, available_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ${NOW_MS})`,
        [
          tenant,
          item.id,
          item.idempotencyKey,
          item.integrationId,
          item.eventType,
          canonicalBody,
          item.receivedAt,
        ],
      );
      if (changed(inserted) === 1) return "stored" as const;
      const [rows] = await pool.query<Row[]>(
        `SELECT id, integration_id, event_type, body_json
         FROM openmatter_inbox WHERE tenant_id = ? AND idempotency_key = ?`,
        [tenant, item.idempotencyKey],
      );
      const existing = rows[0];
      if (
        existing === undefined ||
        str(existing, "id") !== item.id ||
        str(existing, "integration_id") !== item.integrationId ||
        str(existing, "event_type") !== item.eventType ||
        str(existing, "body_json") !== canonicalBody
      ) {
        throw new InboxError({
          message: `Inbox idempotency collision: ${item.idempotencyKey}`,
        });
      }
      return "duplicate" as const;
    });

  const claim: DurableInbox["claim"] = (request) =>
    attempt("Unable to claim durable inbox items", () => {
      if (
        request.ownerId.length === 0 ||
        request.ownerId.length > 191 ||
        !Number.isSafeInteger(request.durationMs) ||
        request.durationMs <= 0 ||
        !Number.isSafeInteger(request.limit) ||
        request.limit <= 0
      ) {
        throw new InboxError({ message: "Invalid inbox claim request" });
      }
      return transaction(async (connection) => {
        const [clock] = await connection.query<Row[]>(
          `SELECT ${NOW_MS} AS now_ms`,
        );
        const now = num(clock[0]!, "now_ms");
        const [rows] = await connection.query<Row[]>(
          `SELECT * FROM openmatter_inbox
           WHERE tenant_id = ?
             AND ((state = 'pending' AND available_at_ms <= ?)
               OR (state = 'leased' AND lease_expires_at_ms <= ?))
           ORDER BY received_at, id
           LIMIT ?
           FOR UPDATE SKIP LOCKED`,
          [tenant, now, now, request.limit],
        );
        const claims: InboxClaim[] = [];
        for (const row of rows) {
          const item = rowToItem(row);
          const token =
            options.makeLeaseToken?.() ??
            `mysql-inbox-${++leaseSequence}-${randomUUID()}`;
          const expiresAtMs = now + request.durationMs;
          const [updated] = await connection.query(
            `UPDATE openmatter_inbox
             SET state = 'leased', attempt = attempt + 1,
                 lease_token = ?, lease_owner = ?, lease_expires_at_ms = ?
             WHERE tenant_id = ? AND id = ?`,
            [token, request.ownerId, expiresAtMs, tenant, item.id],
          );
          if (changed(updated) !== 1) {
            throw new InboxError({
              message: `Unable to fence inbox ${item.id}`,
            });
          }
          claims.push({
            item,
            attempt: num(row, "attempt") + 1,
            lease: {
              token,
              ownerId: request.ownerId,
              expiresAt: new Date(expiresAtMs).toISOString(),
            },
          });
        }
        return claims;
      });
    });

  const complete: DurableInbox["complete"] = (itemId, leaseToken) =>
    attempt("Unable to complete durable inbox item", async () => {
      const [result] = await pool.query(
        `UPDATE openmatter_inbox
         SET state = 'completed', lease_token = NULL, lease_owner = NULL,
             lease_expires_at_ms = NULL, last_error = NULL
         WHERE tenant_id = ? AND id = ? AND state = 'leased' AND lease_token = ?`,
        [tenant, itemId, leaseToken],
      );
      if (changed(result) !== 1) throw stale(itemId);
    });

  const retry: DurableInbox["retry"] = (itemId, leaseToken, input) =>
    attempt("Unable to retry durable inbox item", async () => {
      if (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0) {
        throw new InboxError({ message: "Invalid inbox retry delay" });
      }
      const [result] = await pool.query(
        `UPDATE openmatter_inbox
         SET state = 'pending', available_at_ms = ${NOW_MS} + ?,
             lease_token = NULL, lease_owner = NULL, lease_expires_at_ms = NULL,
             last_error = ?
         WHERE tenant_id = ? AND id = ? AND state = 'leased' AND lease_token = ?`,
        [input.delayMs, input.error ?? null, tenant, itemId, leaseToken],
      );
      if (changed(result) !== 1) throw stale(itemId);
    });

  const renew: DurableInbox["renew"] = (itemId, leaseToken, input) =>
    attempt("Unable to renew durable inbox lease", async () => {
      if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0) {
        throw new InboxError({ message: "Invalid inbox lease duration" });
      }
      const [result] = await pool.query(
        `UPDATE openmatter_inbox SET lease_expires_at_ms = ${NOW_MS} + ?
         WHERE tenant_id = ? AND id = ? AND state = 'leased' AND lease_token = ?`,
        [input.durationMs, tenant, itemId, leaseToken],
      );
      if (changed(result) !== 1) throw stale(itemId);
    });

  const close = Effect.tryPromise({
    try: async () => {
      if (closed) return;
      closed = true;
      if (ownsPool) await pool.end();
    },
    catch: (cause) =>
      new InboxError({ message: "Unable to close MySQL inbox", cause }),
  });

  const inspect = attempt("Unable to inspect inbox", async () => {
    const [rows] = await pool.query<Row[]>(
      `SELECT * FROM openmatter_inbox WHERE tenant_id = ? ORDER BY received_at, id`,
      [tenant],
    );
    return rows.map((row) => ({
      item: rowToItem(row),
      state: str(row, "state"),
      error: typeof row.last_error === "string" ? row.last_error : null,
    }));
  });

  return { enqueue, claim, complete, retry, renew, close, inspect };
};

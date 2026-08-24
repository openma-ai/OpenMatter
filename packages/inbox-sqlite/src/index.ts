import { DatabaseSync } from "node:sqlite";
import { JsonValueSchema, type JsonValue } from "@openmatter/core";
import {
  InboxError,
  type DurableInbox,
  type InboxClaim,
  type InboxItem,
} from "@openmatter/inbox";
import { Effect, Schema } from "effect";

export interface SqliteInboxOptions {
  readonly filename: string;
  readonly makeLeaseToken?: () => string;
}

export interface SqliteInbox extends DurableInbox {
  readonly close: Effect.Effect<void, InboxError>;
}

type Row = Record<string, string | number | bigint | null | Uint8Array>;
type JsonObject = { readonly [key: string]: JsonValue };

const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const canonicalize = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize((value as JsonObject)[key]!)]),
  );
};

const portableItem = (item: InboxItem): InboxItem => {
  if (
    item.id.length === 0 ||
    item.idempotencyKey.length === 0 ||
    item.integrationId.length === 0 ||
    item.eventType.length === 0 ||
    !Number.isFinite(Date.parse(item.receivedAt)) ||
    !Schema.is(JsonValueSchema)(item.body)
  ) {
    throw new InboxError({ message: "Invalid durable inbox item" });
  }
  return {
    ...item,
    body: structuredClone(item.body),
  };
};

const bodyJson = (body: JsonValue) => JSON.stringify(canonicalize(body));

const requiredString = (row: Row, key: string): string => {
  const value = row[key];
  if (typeof value !== "string") {
    throw new InboxError({ message: `Invalid SQLite inbox ${key}` });
  }
  return value;
};

const requiredNumber = (row: Row, key: string): number => {
  const value = row[key];
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isSafeInteger(numeric)) {
    throw new InboxError({ message: `Invalid SQLite inbox ${key}` });
  }
  return numeric;
};

export const makeSqliteInbox = (options: SqliteInboxOptions): SqliteInbox => {
  const database = new DatabaseSync(options.filename);
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS openmatter_inbox (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      integration_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      body_json TEXT NOT NULL,
      received_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'completed')),
      available_at_ms INTEGER NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,
      lease_owner TEXT,
      lease_expires_at_ms INTEGER,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS openmatter_inbox_claimable
      ON openmatter_inbox(state, available_at_ms, lease_expires_at_ms, received_at);
  `);
  let closed = false;
  let leaseSequence = 0;

  const attempt = <A>(message: string, operation: () => A) =>
    Effect.try({
      try: () => {
        if (closed) throw new InboxError({ message: "SQLite inbox is closed" });
        return operation();
      },
      catch: (cause) =>
        cause instanceof InboxError
          ? cause
          : new InboxError({ message, cause }),
    });

  const transaction = <A>(operation: () => A): A => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      database.exec("COMMIT");
      return result;
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  };

  const nowMs = (): number => {
    const row = database
      .prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now_ms")
      .get();
    if (!isRecord(row)) {
      throw new InboxError({ message: "SQLite did not return its clock" });
    }
    return requiredNumber(row, "now_ms");
  };

  const rowToItem = (row: Row): InboxItem => {
    const parsed = JSON.parse(requiredString(row, "body_json")) as unknown;
    if (!Schema.is(JsonValueSchema)(parsed)) {
      throw new InboxError({
        message: "SQLite inbox body is not portable JSON",
      });
    }
    return {
      id: requiredString(row, "id"),
      idempotencyKey: requiredString(row, "idempotency_key"),
      integrationId: requiredString(row, "integration_id"),
      eventType: requiredString(row, "event_type"),
      body: structuredClone(parsed),
      receivedAt: requiredString(row, "received_at"),
    };
  };

  const enqueue: DurableInbox["enqueue"] = (input) =>
    attempt("Unable to enqueue durable inbox item", () =>
      transaction(() => {
        const item = portableItem(input);
        const canonicalBody = bodyJson(item.body);
        const result = database
          .prepare(
            `INSERT INTO openmatter_inbox (
              id, idempotency_key, integration_id, event_type, body_json,
              received_at, state, available_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
            ON CONFLICT(idempotency_key) DO NOTHING`,
          )
          .run(
            item.id,
            item.idempotencyKey,
            item.integrationId,
            item.eventType,
            canonicalBody,
            item.receivedAt,
            nowMs(),
          );
        if (Number(result.changes) === 1) return "stored" as const;
        const existing = database
          .prepare(
            `SELECT id, idempotency_key, integration_id, event_type,
                    body_json, received_at
             FROM openmatter_inbox WHERE idempotency_key = ?`,
          )
          .get(item.idempotencyKey);
        if (
          !isRecord(existing) ||
          requiredString(existing, "id") !== item.id ||
          requiredString(existing, "integration_id") !== item.integrationId ||
          requiredString(existing, "event_type") !== item.eventType ||
          requiredString(existing, "body_json") !== canonicalBody
        ) {
          throw new InboxError({
            message: `Inbox idempotency collision: ${item.idempotencyKey}`,
          });
        }
        return "duplicate" as const;
      }),
    );

  const claim: DurableInbox["claim"] = (request) =>
    attempt("Unable to claim durable inbox items", () =>
      transaction(() => {
        if (
          request.ownerId.length === 0 ||
          !Number.isSafeInteger(request.durationMs) ||
          request.durationMs <= 0 ||
          !Number.isSafeInteger(request.limit) ||
          request.limit <= 0
        ) {
          throw new InboxError({ message: "Invalid inbox claim request" });
        }
        const now = nowMs();
        const rows = database
          .prepare(
            `SELECT * FROM openmatter_inbox
             WHERE (state = 'pending' AND available_at_ms <= ?)
                OR (state = 'leased' AND lease_expires_at_ms <= ?)
             ORDER BY received_at, id
             LIMIT ?`,
          )
          .all(now, now, request.limit)
          .filter(isRecord);
        return rows.map((row): InboxClaim => {
          const item = rowToItem(row);
          const token =
            options.makeLeaseToken?.() ??
            `sqlite-inbox-${++leaseSequence}-${globalThis.crypto.randomUUID()}`;
          const expiresAtMs = now + request.durationMs;
          const updated = database
            .prepare(
              `UPDATE openmatter_inbox
               SET state = 'leased', attempt = attempt + 1,
                   lease_token = ?, lease_owner = ?, lease_expires_at_ms = ?
               WHERE id = ?`,
            )
            .run(token, request.ownerId, expiresAtMs, item.id);
          if (Number(updated.changes) !== 1) {
            throw new InboxError({
              message: `Unable to fence inbox ${item.id}`,
            });
          }
          return {
            item,
            attempt: requiredNumber(row, "attempt") + 1,
            lease: {
              token,
              ownerId: request.ownerId,
              expiresAt: new Date(expiresAtMs).toISOString(),
            },
          };
        });
      }),
    );

  const complete: DurableInbox["complete"] = (itemId, leaseToken) =>
    attempt("Unable to complete durable inbox item", () => {
      const result = database
        .prepare(
          `UPDATE openmatter_inbox
           SET state = 'completed', lease_token = NULL, lease_owner = NULL,
               lease_expires_at_ms = NULL, last_error = NULL
           WHERE id = ? AND state = 'leased' AND lease_token = ?`,
        )
        .run(itemId, leaseToken);
      if (Number(result.changes) !== 1) {
        throw new InboxError({
          message: `Invalid or stale inbox lease for ${itemId}`,
        });
      }
    });

  const retry: DurableInbox["retry"] = (itemId, leaseToken, input) =>
    attempt("Unable to retry durable inbox item", () => {
      if (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0) {
        throw new InboxError({ message: "Invalid inbox retry delay" });
      }
      const result = database
        .prepare(
          `UPDATE openmatter_inbox
           SET state = 'pending', available_at_ms = ?, lease_token = NULL,
               lease_owner = NULL, lease_expires_at_ms = NULL, last_error = ?
           WHERE id = ? AND state = 'leased' AND lease_token = ?`,
        )
        .run(nowMs() + input.delayMs, input.error ?? null, itemId, leaseToken);
      if (Number(result.changes) !== 1) {
        throw new InboxError({
          message: `Invalid or stale inbox lease for ${itemId}`,
        });
      }
    });

  const renew: DurableInbox["renew"] = (itemId, leaseToken, input) =>
    attempt("Unable to renew durable inbox lease", () => {
      if (!Number.isSafeInteger(input.durationMs) || input.durationMs <= 0) {
        throw new InboxError({ message: "Invalid inbox lease duration" });
      }
      const result = database
        .prepare(
          `UPDATE openmatter_inbox SET lease_expires_at_ms = ?
           WHERE id = ? AND state = 'leased' AND lease_token = ?`,
        )
        .run(nowMs() + input.durationMs, itemId, leaseToken);
      if (Number(result.changes) !== 1) {
        throw new InboxError({
          message: `Invalid or stale inbox lease for ${itemId}`,
        });
      }
    });

  const close = Effect.try({
    try: () => {
      if (closed) return;
      database.close();
      closed = true;
    },
    catch: (cause) =>
      new InboxError({ message: "Unable to close inbox", cause }),
  });

  return { enqueue, claim, complete, retry, renew, close };
};

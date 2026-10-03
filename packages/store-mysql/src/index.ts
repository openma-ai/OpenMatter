import { randomUUID } from "node:crypto";
import {
  createPool,
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";
import {
  JsonValueSchema,
  ThreadGoalStatusSchema,
  type AgentSession,
  type ContextProjection,
  type EffectDeliveryReceipt,
  type PermissionDecision,
  type Reaction,
  type ThreadGoal,
  type Turn,
  type TurnCancellationRequest,
  type WorkEvent,
} from "@openmatter/core";
import type { OpenMAEvent } from "@openmatter/agent";
import {
  StoreError,
  type AccountThreadGoalInput,
  type LeaseRequest,
  type OpenMatterStore,
  type PendingEffectClaim,
  type StoreSnapshot,
  type WorkLease,
} from "@openmatter/store";
import { Effect, Schema } from "effect";

export interface MysqlStore extends OpenMatterStore {
  readonly close: Effect.Effect<void, StoreError>;
  readonly inspect: Effect.Effect<StoreSnapshot, StoreError>;
  readonly inspectScope: (
    scopeId: string,
  ) => Effect.Effect<StoreSnapshot, StoreError>;
}

export interface MysqlStoreOptions {
  readonly tenantId: string;
  readonly url?: string;
  readonly pool?: Pool;
}

type LeaseRow = {
  token: string;
  owner_id: string;
  expires_ms: number;
  revision: number;
};

const initialized = new WeakSet<Pool>();

const schema = [
  `CREATE TABLE IF NOT EXISTS openmatter_store_records (
    tenant_id VARCHAR(191) NOT NULL,
    kind VARCHAR(64) NOT NULL,
    id VARCHAR(191) NOT NULL,
    scope_id VARCHAR(191) NULL,
    parent_id VARCHAR(191) NULL,
    unique_key VARCHAR(191) NULL,
    data LONGTEXT NOT NULL,
    seq BIGINT NOT NULL AUTO_INCREMENT,
    PRIMARY KEY (tenant_id, kind, id),
    UNIQUE KEY openmatter_store_unique (tenant_id, kind, unique_key),
    KEY openmatter_store_scope (tenant_id, kind, scope_id),
    KEY openmatter_store_parent (tenant_id, kind, parent_id),
    KEY openmatter_store_seq (seq)
  )`,
  `CREATE TABLE IF NOT EXISTS openmatter_store_leases (
    tenant_id VARCHAR(191) NOT NULL,
    kind VARCHAR(64) NOT NULL,
    id VARCHAR(191) NOT NULL,
    token VARCHAR(64) NOT NULL,
    owner_id VARCHAR(191) NOT NULL,
    expires_ms BIGINT NOT NULL,
    revision INT NOT NULL,
    attempt INT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, kind, id)
  )`,
  `CREATE TABLE IF NOT EXISTS openmatter_store_bindings (
    tenant_id VARCHAR(191) NOT NULL,
    binding_key VARCHAR(512) NOT NULL,
    session_id VARCHAR(191) NOT NULL,
    PRIMARY KEY (tenant_id, binding_key)
  )`,
];

const asNumber = (value: unknown): number =>
  typeof value === "bigint" ? Number(value) : Number(value);

/** MySQL adapter for the OpenMatter store port. One instance is bound to one tenant. */
export const makeMysqlStore = (options: MysqlStoreOptions): MysqlStore => {
  if (!options.tenantId.trim())
    throw new StoreError({ message: "MySQL store requires a tenant id" });
  const owned = options.pool === undefined;
  const pool =
    options.pool ??
    createPool(options.url ?? process.env.PROJECT_WORKER_MYSQL_URL ?? "");
  const tenantId = options.tenantId;
  let closed = false;
  let chain = Promise.resolve();
  const fail = (message: string): never => {
    throw new StoreError({ message });
  };
  const exclusive = <T>(body: () => Promise<T>): Promise<T> => {
    const run = chain.then(body, body);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const ensure = async () => {
    if (initialized.has(pool)) return;
    const conn = await pool.getConnection();
    try {
      for (const statement of schema) await conn.query(statement);
      initialized.add(pool);
    } finally {
      conn.release();
    }
  };
  const encode = (value: unknown): string => {
    if (!Schema.is(JsonValueSchema)(value))
      fail("Store facts must be portable JSON");
    return JSON.stringify(value);
  };
  const query = async <T>(
    conn: PoolConnection,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> => {
    const [rows] = await conn.query<RowDataPacket[]>(sql, params);
    return rows as T[];
  };
  const one = async <T>(
    conn: PoolConnection,
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> => (await query<T>(conn, sql, params))[0];
  const withTx = async <T>(
    write: boolean,
    body: (conn: PoolConnection) => Promise<T>,
  ): Promise<T> => {
    if (closed) fail("MySQL store is closed");
    await ensure();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      if (write)
        await conn.query(
          "SELECT 1 FROM openmatter_store_leases LIMIT 1 FOR UPDATE",
        );
      const result = await body(conn);
      await conn.commit();
      return result;
    } catch (cause) {
      await conn.rollback();
      throw cause;
    } finally {
      conn.release();
    }
  };
  const op = <T>(
    body: (conn: PoolConnection) => Promise<T>,
    write = false,
  ): Effect.Effect<T, StoreError> =>
    Effect.tryPromise({
      try: () => exclusive(() => withTx(write, body)),
      catch: (cause) =>
        cause instanceof StoreError
          ? cause
          : new StoreError({
              message: "MySQL store operation failed",
              cause,
            }),
    });
  const clock = async (conn: PoolConnection) =>
    asNumber(
      (
        await one<{ now: unknown }>(
          conn,
          "SELECT ROUND(UNIX_TIMESTAMP(NOW(3)) * 1000) AS now",
        )
      )?.now,
    );
  const read = async <T>(
    conn: PoolConnection,
    sql: string,
    params: unknown[],
  ): Promise<T | undefined> => {
    const row = await one<{ data: string }>(conn, sql, params);
    return row ? (JSON.parse(row.data) as T) : undefined;
  };
  const get = async <T>(conn: PoolConnection, kind: string, id: string) =>
    read<T>(
      conn,
      "SELECT data FROM openmatter_store_records WHERE tenant_id=? AND kind=? AND id=?",
      [tenantId, kind, id],
    );
  const rows = async <T>(
    conn: PoolConnection,
    kind: string,
    clause = "",
    params: unknown[] = [],
  ): Promise<T[]> =>
    (
      await query<{ data: string }>(
        conn,
        `SELECT data FROM openmatter_store_records WHERE tenant_id=? AND kind=? ${clause} ORDER BY seq`,
        [tenantId, kind, ...params],
      )
    ).map((row) => JSON.parse(row.data) as T);
  const put = async (
    conn: PoolConnection,
    kind: string,
    id: string,
    value: unknown,
    scope: string | null = null,
    parent: string | null = null,
    key: string | null = null,
  ) => {
    await conn.query(
      `INSERT INTO openmatter_store_records (tenant_id, kind, id, scope_id, parent_id, unique_key, data)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE data=VALUES(data), scope_id=VALUES(scope_id), parent_id=VALUES(parent_id), unique_key=VALUES(unique_key)`,
      [tenantId, kind, id, scope, parent, key, encode(value)],
    );
  };
  const remove = async (conn: PoolConnection, kind: string, id: string) => {
    await conn.query(
      "DELETE FROM openmatter_store_records WHERE tenant_id=? AND kind=? AND id=?",
      [tenantId, kind, id],
    );
  };
  const leaseRow = async (conn: PoolConnection, kind: string, id: string) => {
    const row = await one<LeaseRow & { expires_ms: unknown }>(
      conn,
      "SELECT token, owner_id, expires_ms, revision FROM openmatter_store_leases WHERE tenant_id=? AND kind=? AND id=?",
      [tenantId, kind, id],
    );
    return row
      ? {
          ...row,
          expires_ms: asNumber(row.expires_ms),
          revision: asNumber(row.revision),
        }
      : undefined;
  };
  const asLease = (row: LeaseRow): WorkLease => ({
    token: row.token,
    ownerId: row.owner_id,
    expiresAt: new Date(row.expires_ms).toISOString(),
    revision: row.revision,
  });
  const duration = (ms: number) => {
    if (!Number.isSafeInteger(ms) || ms <= 0)
      fail("Lease duration must be a positive integer");
    return ms;
  };
  const acquire = async (
    conn: PoolConnection,
    kind: string,
    id: string,
    request: LeaseRequest,
    attempt = 0,
  ): Promise<WorkLease> => {
    const row = await leaseRow(conn, kind, id);
    const next: LeaseRow = {
      token: randomUUID(),
      owner_id: request.ownerId,
      expires_ms: (await clock(conn)) + duration(request.durationMs),
      revision: (row?.revision ?? 0) + 1,
    };
    await conn.query(
      `INSERT INTO openmatter_store_leases (tenant_id, kind, id, token, owner_id, expires_ms, revision, attempt)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE token=VALUES(token), owner_id=VALUES(owner_id), expires_ms=VALUES(expires_ms), revision=VALUES(revision), attempt=VALUES(attempt)`,
      [
        tenantId,
        kind,
        id,
        next.token,
        next.owner_id,
        next.expires_ms,
        next.revision,
        attempt,
      ],
    );
    return asLease(next);
  };
  const fence = async (
    conn: PoolConnection,
    kind: string,
    id: string,
    token: string,
  ) => {
    const row = await leaseRow(conn, kind, id);
    if (!row || row.token !== token || row.expires_ms <= (await clock(conn)))
      fail(`Invalid, expired or stale ${kind} lease: ${id}`);
    return row;
  };
  const renew = (kind: string, id: string, token: string, ms: number) =>
    op(async (conn) => {
      await fence(conn, kind, id, token);
      await conn.query(
        "UPDATE openmatter_store_leases SET expires_ms=? WHERE tenant_id=? AND kind=? AND id=?",
        [(await clock(conn)) + duration(ms), tenantId, kind, id],
      );
    }, true);
  const release = async (conn: PoolConnection, kind: string, id: string) => {
    await conn.query(
      "UPDATE openmatter_store_leases SET expires_ms=0 WHERE tenant_id=? AND kind=? AND id=?",
      [tenantId, kind, id],
    );
  };
  const activeSession = async (conn: PoolConnection, key: string) => {
    const row = await one<{ session_id: string }>(
      conn,
      "SELECT session_id FROM openmatter_store_bindings WHERE tenant_id=? AND binding_key=?",
      [tenantId, key],
    );
    return row ? get<AgentSession>(conn, "session", row.session_id) : undefined;
  };
  const receipt = async (conn: PoolConnection, eventId: string) => {
    const reaction = await get<Reaction>(conn, "reaction", eventId);
    if (!reaction) return undefined;
    const deliveries: EffectDeliveryReceipt[] = [];
    for (const effect of reaction.effects) {
      const result = await get<EffectDeliveryReceipt>(
        conn,
        "delivery",
        effect.id,
      );
      if (result) deliveries.push(result);
    }
    return { reaction, deliveries, duplicate: false as const };
  };
  const goalByThread = (conn: PoolConnection, workThreadId: string) =>
    read<ThreadGoal>(
      conn,
      "SELECT data FROM openmatter_store_records WHERE tenant_id=? AND kind='goal' AND unique_key=?",
      [tenantId, workThreadId],
    );
  const goalObjective = (objective: string) => {
    const normalized = objective.trim();
    if (!normalized) fail("Goal objective must not be blank");
    return normalized;
  };
  const goalBudget = (budget: number | undefined) => {
    if (budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0))
      fail("Goal token budget must be a positive safe integer");
  };
  const requireGoal = async (
    conn: PoolConnection,
    workThreadId: string,
    expectedGoalId?: string,
  ): Promise<ThreadGoal> => {
    const goal = await goalByThread(conn, workThreadId);
    if (!goal) return fail(`No goal for WorkThread ${workThreadId}`);
    if (expectedGoalId !== undefined && goal.id !== expectedGoalId)
      return fail("Stale goal identity");
    return goal;
  };
  const removeGoalUsage = async (conn: PoolConnection, goalId: string) => {
    await conn.query(
      "DELETE FROM openmatter_store_records WHERE tenant_id=? AND kind='goalUsage' AND parent_id=?",
      [tenantId, goalId],
    );
  };
  const snapshot = async (
    conn: PoolConnection,
    scopeId?: string,
  ): Promise<StoreSnapshot> => {
    const scopeClause = scopeId === undefined ? "" : "AND scope_id=?";
    const params = scopeId === undefined ? [] : [scopeId];
    const contexts = await rows<ContextProjection>(
      conn,
      "context",
      scopeClause,
      params,
    );
    const sessions = await rows<AgentSession>(
      conn,
      "session",
      scopeClause,
      params,
    );
    const sessionIds = new Set(sessions.map((session) => session.id));
    const turns = (await rows<Turn>(conn, "turn")).filter(
      (turn) => scopeId === undefined || sessionIds.has(turn.sessionId),
    );
    const turnIds = new Set(turns.map((turn) => turn.id));
    const eventIds = new Set([
      ...contexts.map((context) => context.triggerEventId),
      ...turns.map((turn) => turn.triggerEventId),
    ]);
    const events = (await rows<WorkEvent>(conn, "event")).filter(
      (event) =>
        scopeId === undefined ||
        eventIds.has(event.id) ||
        event.source.conversationId === scopeId,
    );
    for (const event of events) eventIds.add(event.id);
    const reactions = (await rows<Reaction>(conn, "reaction")).filter(
      (reaction) => scopeId === undefined || eventIds.has(reaction.eventId),
    );
    const effectIds = new Set(
      reactions.flatMap((reaction) =>
        reaction.effects.map((effect) => effect.id),
      ),
    );
    return {
      goals: await rows<ThreadGoal>(conn, "goal", scopeClause, params),
      contexts,
      sessions,
      turns,
      events,
      reactions,
      deliveries: (await rows<EffectDeliveryReceipt>(conn, "delivery")).filter(
        (delivery) => scopeId === undefined || effectIds.has(delivery.effectId),
      ),
      agentEvents: (await rows<OpenMAEvent>(conn, "agentEvent")).filter(
        (event) => scopeId === undefined || turnIds.has(event.turn_id ?? ""),
      ),
      permissionDecisions: (
        await rows<PermissionDecision>(conn, "permission")
      ).filter(
        (decision) => scopeId === undefined || turnIds.has(decision.turnId),
      ),
      turnCancellationRequests: (
        await rows<TurnCancellationRequest>(conn, "cancellation")
      ).filter(
        (request) => scopeId === undefined || turnIds.has(request.turnId),
      ),
    };
  };

  const store: MysqlStore = {
    close: Effect.tryPromise({
      try: async () => {
        if (closed) return;
        closed = true;
        if (owned) await pool.end();
      },
      catch: (cause) =>
        new StoreError({ message: "Unable to close MySQL store", cause }),
    }),
    inspect: op((conn) => snapshot(conn)),
    inspectScope: (scope) => op((conn) => snapshot(conn, scope)),
    createThreadGoal: (input) =>
      op(async (conn) => {
        if (!input.scopeId.trim() || !input.workThreadId.trim())
          fail("Goal scope and WorkThread identities must not be blank");
        const objective = goalObjective(input.objective);
        goalBudget(input.tokenBudget);
        const existing = await goalByThread(conn, input.workThreadId);
        if (existing && existing.scopeId !== input.scopeId)
          fail("Goal WorkThread belongs to another scope");
        if (existing && existing.status !== "complete")
          fail("WorkThread already has an unfinished goal");
        const now = new Date(await clock(conn)).toISOString();
        const goal: ThreadGoal = {
          id: randomUUID(),
          scopeId: input.scopeId,
          workThreadId: input.workThreadId,
          objective,
          status: "active",
          ...(input.tokenBudget === undefined
            ? {}
            : { tokenBudget: input.tokenBudget }),
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: now,
          updatedAt: now,
          revision: 1,
        };
        if (existing) {
          await removeGoalUsage(conn, existing.id);
          await remove(conn, "goal", existing.id);
        }
        await put(
          conn,
          "goal",
          goal.id,
          goal,
          goal.scopeId,
          goal.workThreadId,
          goal.workThreadId,
        );
        return goal;
      }, true),
    getThreadGoal: (workThreadId) =>
      op((conn) => goalByThread(conn, workThreadId)),
    listThreadGoals: (scopeId) =>
      op((conn) =>
        scopeId === undefined
          ? rows<ThreadGoal>(conn, "goal")
          : rows<ThreadGoal>(conn, "goal", "AND scope_id=?", [scopeId]),
      ),
    updateThreadGoal: (workThreadId, input) =>
      op(async (conn) => {
        const goal = await requireGoal(
          conn,
          workThreadId,
          input.expectedGoalId,
        );
        if (
          input.expectedRevision !== undefined &&
          input.expectedRevision !== goal.revision
        )
          fail("Stale goal revision");
        const objective =
          input.objective === undefined
            ? goal.objective
            : goalObjective(input.objective);
        const tokenBudget =
          input.tokenBudget === undefined
            ? goal.tokenBudget
            : (input.tokenBudget ?? undefined);
        goalBudget(tokenBudget);
        let status = input.status ?? goal.status;
        if (!Schema.is(ThreadGoalStatusSchema)(status))
          fail("Invalid goal status");
        if (
          status === "active" &&
          tokenBudget !== undefined &&
          goal.tokensUsed >= tokenBudget
        )
          status = "budget_limited";
        const reason =
          input.reason === undefined
            ? input.status === "active" || input.status === "complete"
              ? undefined
              : goal.reason
            : input.reason.trim() || undefined;
        if (
          objective === goal.objective &&
          tokenBudget === goal.tokenBudget &&
          status === goal.status &&
          reason === goal.reason
        )
          return goal;
        const { tokenBudget: _budget, reason: _reason, ...base } = goal;
        const updated: ThreadGoal = {
          ...base,
          objective,
          status,
          ...(tokenBudget === undefined ? {} : { tokenBudget }),
          ...(reason === undefined ? {} : { reason }),
          updatedAt: new Date(await clock(conn)).toISOString(),
          revision: goal.revision + 1,
        };
        await put(
          conn,
          "goal",
          goal.id,
          updated,
          goal.scopeId,
          goal.workThreadId,
          goal.workThreadId,
        );
        return updated;
      }, true),
    accountThreadGoal: (workThreadId, input) =>
      op(async (conn) => {
        const goal = await requireGoal(conn, workThreadId, input.goalId);
        if (!input.turnId.trim()) fail("Goal usage requires a Turn identity");
        for (const value of [input.tokensUsed, input.timeUsedSeconds]) {
          if (!Number.isSafeInteger(value) || value < 0)
            fail("Goal usage must be nonnegative safe integers");
        }
        const id = `${goal.id}:${input.turnId}`;
        const existing = await get<AccountThreadGoalInput>(
          conn,
          "goalUsage",
          id,
        );
        if (existing) {
          if (
            existing.tokensUsed !== input.tokensUsed ||
            existing.timeUsedSeconds !== input.timeUsedSeconds
          )
            fail("Conflicting goal usage for Turn");
          return goal;
        }
        const tokensUsed = goal.tokensUsed + input.tokensUsed;
        const timeUsedSeconds = goal.timeUsedSeconds + input.timeUsedSeconds;
        if (
          !Number.isSafeInteger(tokensUsed) ||
          !Number.isSafeInteger(timeUsedSeconds)
        )
          fail("Goal usage exceeds safe integer range");
        const updated: ThreadGoal = {
          ...goal,
          tokensUsed,
          timeUsedSeconds,
          status:
            goal.status === "active" &&
            goal.tokenBudget !== undefined &&
            tokensUsed >= goal.tokenBudget
              ? "budget_limited"
              : goal.status,
          updatedAt: new Date(await clock(conn)).toISOString(),
          revision: goal.revision + 1,
        };
        await put(conn, "goalUsage", id, input, goal.scopeId, goal.id, id);
        await put(
          conn,
          "goal",
          goal.id,
          updated,
          goal.scopeId,
          goal.workThreadId,
          goal.workThreadId,
        );
        return updated;
      }, true),
    clearThreadGoal: (workThreadId, expectedGoalId) =>
      op(async (conn) => {
        const goal = await goalByThread(conn, workThreadId);
        if (!goal) return false;
        if (expectedGoalId !== undefined && goal.id !== expectedGoalId)
          fail("Stale goal identity");
        await removeGoalUsage(conn, goal.id);
        await remove(conn, "goal", goal.id);
        return true;
      }, true),
    claimEvent: (event, request) =>
      op(async (conn) => {
        const existing = await read<WorkEvent>(
          conn,
          "SELECT data FROM openmatter_store_records WHERE tenant_id=? AND kind='event' AND unique_key=?",
          [tenantId, event.idempotencyKey],
        );
        const fact = existing ?? event;
        const terminal = await receipt(conn, fact.id);
        if (terminal) return { _tag: "Terminal" as const, receipt: terminal };
        const current = await leaseRow(conn, "event", fact.id);
        if (current && current.expires_ms > (await clock(conn)))
          return { _tag: "Busy" as const, lease: asLease(current) };
        if (!existing) {
          if (await get(conn, "event", fact.id))
            fail("Event ID already belongs to a different idempotency key");
          await put(
            conn,
            "event",
            fact.id,
            fact,
            fact.source.conversationId ?? null,
            null,
            fact.idempotencyKey,
          );
        }
        return {
          _tag: "Acquired" as const,
          event: fact,
          lease: await acquire(conn, "event", fact.id, request),
        };
      }, true),
    commitTerminalReaction: (reaction, token) =>
      op(async (conn) => {
        await fence(conn, "event", reaction.eventId, token);
        const existing = await get<Reaction>(
          conn,
          "reaction",
          reaction.eventId,
        );
        if (existing) return { _tag: "Existing" as const, reaction: existing };
        await put(conn, "reaction", reaction.eventId, reaction);
        return {
          _tag: "Committed" as const,
          reaction: (await get<Reaction>(conn, "reaction", reaction.eventId))!,
        };
      }, true),
    renewEventLease: (id, token, request) =>
      renew("event", id, token, request.durationMs),
    getReceipt: (id) => op((conn) => receipt(conn, id)),
    claimPendingEffects: (request) =>
      op(async (conn) => {
        if (!Number.isSafeInteger(request.limit) || request.limit < 0)
          fail("Invalid effect claim limit");
        const effects = (await rows<Reaction>(conn, "reaction"))
          .filter(
            (reaction) =>
              request.eventId === undefined ||
              reaction.eventId === request.eventId,
          )
          .flatMap((reaction) => reaction.effects)
          .sort((left, right) => left.id.localeCompare(right.id));
        const pending: PendingEffectClaim[] = [];
        const now = await clock(conn);
        for (const effect of effects) {
          if (pending.length >= request.limit) break;
          const delivered = await get<EffectDeliveryReceipt>(
            conn,
            "delivery",
            effect.id,
          );
          if (
            delivered &&
            (delivered.status !== "retryable-failed" ||
              (delivered.nextRetryAt !== undefined &&
                Date.parse(delivered.nextRetryAt) > now))
          )
            continue;
          const current = await leaseRow(conn, "effect", effect.id);
          if (current && current.expires_ms > now) continue;
          const previous = await one<{ attempt: unknown }>(
            conn,
            "SELECT attempt FROM openmatter_store_leases WHERE tenant_id=? AND kind='effect' AND id=?",
            [tenantId, effect.id],
          );
          const attempt =
            Math.max(
              asNumber(previous?.attempt ?? 0),
              delivered?.attempt ?? 0,
            ) + 1;
          pending.push({
            effect,
            attempt,
            lease: await acquire(conn, "effect", effect.id, request, attempt),
          });
        }
        return pending;
      }, true),
    recordDelivery: (value, token) =>
      op(async (conn) => {
        await fence(conn, "effect", value.effectId, token);
        await put(conn, "delivery", value.effectId, value);
        await release(conn, "effect", value.effectId);
      }, true),
    renewEffectLease: (id, token, request) =>
      renew("effect", id, token, request.durationMs),
    claimSession: (key, request) =>
      op(async (conn) => {
        const current = await leaseRow(conn, "session", key);
        if (current && current.expires_ms > (await clock(conn)))
          return { _tag: "Busy" as const, lease: asLease(current) };
        const session = await activeSession(conn, key);
        return {
          _tag: "Acquired" as const,
          lease: await acquire(conn, "session", key, request),
          ...(session ? { session } : {}),
        };
      }, true),
    saveSession: (session, token) =>
      op(async (conn) => {
        await fence(conn, "session", session.bindingKey, token);
        const previous = await activeSession(conn, session.bindingKey);
        if (
          previous &&
          previous.id !== session.id &&
          ["open", "creating"].includes(previous.state)
        )
          await put(
            conn,
            "session",
            previous.id,
            { ...previous, state: "closed" },
            previous.scopeId,
            previous.bindingKey,
          );
        await put(
          conn,
          "session",
          session.id,
          session,
          session.scopeId,
          session.bindingKey,
        );
        await conn.query(
          `INSERT INTO openmatter_store_bindings (tenant_id, binding_key, session_id) VALUES (?,?,?)
           ON DUPLICATE KEY UPDATE session_id=VALUES(session_id)`,
          [tenantId, session.bindingKey, session.id],
        );
      }, true),
    getSession: (id) => op((conn) => get<AgentSession>(conn, "session", id)),
    renewSessionLease: (key, token, request) =>
      renew("session", key, token, request.durationMs),
    releaseSession: (key, token) =>
      op(async (conn) => {
        await fence(conn, "session", key, token);
        await release(conn, "session", key);
      }, true),
    saveTurn: (turn, key, token) =>
      op(async (conn) => {
        await fence(conn, "session", key, token);
        if (
          (await get<AgentSession>(conn, "session", turn.sessionId))
            ?.bindingKey !== key
        )
          fail("Turn belongs to another session binding");
        const terminal = (
          await rows<OpenMAEvent>(conn, "agentEvent", "AND parent_id=?", [
            turn.id,
          ])
        ).find((event) =>
          [
            "turn.completed",
            "turn.failed",
            "turn.cancelled",
            "turn.interrupted",
          ].includes(event.type),
        );
        if (
          terminal &&
          turn.state !==
            (terminal.type === "turn.interrupted"
              ? "cancelled"
              : terminal.type.slice(5))
        )
          return;
        await put(conn, "turn", turn.id, turn, null, turn.sessionId);
      }, true),
    getTurn: (id) => op((conn) => get<Turn>(conn, "turn", id)),
    requestTurnCancellation: (key, eventId, at) =>
      op(async (conn) => {
        const session = await activeSession(conn, key);
        if (!session) return undefined;
        const turn = (
          await rows<Turn>(conn, "turn", "AND parent_id=?", [session.id])
        )
          .filter((item) => item.state === "queued" || item.state === "running")
          .sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt),
          )[0];
        if (!turn) return undefined;
        const existing = await get<TurnCancellationRequest>(
          conn,
          "cancellation",
          turn.id,
        );
        if (existing) return existing;
        const value = {
          turnId: turn.id,
          sessionId: session.id,
          bindingKey: key,
          requestedByEventId: eventId,
          requestedAt: at,
        };
        await put(conn, "cancellation", turn.id, value);
        return value;
      }, true),
    getTurnCancellation: (id) =>
      op((conn) => get<TurnCancellationRequest>(conn, "cancellation", id)),
    getAgentEvents: (id) =>
      op(async (conn) =>
        (
          await rows<OpenMAEvent>(conn, "agentEvent", "AND parent_id=?", [id])
        ).sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0)),
      ),
    getPermissionDecision: (turnId, requestId) =>
      op((conn) =>
        get<PermissionDecision>(
          conn,
          "permission",
          JSON.stringify([turnId, requestId]),
        ),
      ),
    commitPermissionDecision: (decision, key, token) =>
      op(async (conn) => {
        await fence(conn, "session", key, token);
        const turn = await get<Turn>(conn, "turn", decision.turnId);
        if (
          !turn ||
          (await get<AgentSession>(conn, "session", turn.sessionId))
            ?.bindingKey !== key
        )
          fail("Permission belongs to another session binding");
        const id = JSON.stringify([decision.turnId, decision.requestId]);
        const existing = await get<PermissionDecision>(conn, "permission", id);
        if (existing) return existing;
        await put(conn, "permission", id, decision);
        return (await get<PermissionDecision>(conn, "permission", id))!;
      }, true),
    appendAgentEvent: (event, key, token) =>
      op(async (conn) => {
        await fence(conn, "session", key, token);
        const turnId = event.turn_id;
        if (!turnId || event.seq === undefined)
          return fail("Agent event requires turn identity and sequence");
        if (
          (await get<AgentSession>(conn, "session", event.session_id))
            ?.bindingKey !== key ||
          (await get<Turn>(conn, "turn", turnId))?.sessionId !==
            event.session_id
        )
          return fail("Agent event belongs to another session binding");
        const id = JSON.stringify([turnId, event.seq]);
        const existing = await get<OpenMAEvent>(conn, "agentEvent", id);
        if (existing) {
          if (encode(existing) !== encode(event))
            fail("Conflicting Agent event sequence");
          return;
        }
        await put(conn, "agentEvent", id, event, null, turnId, event.event_id);
      }, true),
    saveContext: (context) =>
      op(async (conn) => {
        await put(
          conn,
          "context",
          context.id,
          context,
          context.scopeId,
          context.workThreadId,
        );
      }, true),
    getContext: (id) =>
      op((conn) => get<ContextProjection>(conn, "context", id)),
  };
  return store;
};

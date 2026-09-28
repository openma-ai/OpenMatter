import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { JsonValueSchema, ThreadGoalStatusSchema } from "@openmatter/core";
import { StoreError } from "@openmatter/store";
import { Effect, Schema } from "effect";
//#region src/index.ts
/** SQLite persistence only. Scheduling, association and turn execution stay in runtime. */
const makeSqliteStore = (options) => {
	const owned = "filename" in options;
	const db = "database" in options ? options.database : new DatabaseSync(options.filename);
	db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
	db.exec(`
    CREATE TABLE IF NOT EXISTS openmatter_store_records (
      kind TEXT NOT NULL, id TEXT NOT NULL, scope_id TEXT, parent_id TEXT,
      unique_key TEXT, data TEXT NOT NULL, PRIMARY KEY(kind, id), UNIQUE(kind, unique_key)
    );
    CREATE INDEX IF NOT EXISTS openmatter_store_scope ON openmatter_store_records(kind, scope_id);
    CREATE INDEX IF NOT EXISTS openmatter_store_parent ON openmatter_store_records(kind, parent_id);
    CREATE TABLE IF NOT EXISTS openmatter_store_leases (
      kind TEXT NOT NULL, id TEXT NOT NULL, token TEXT NOT NULL, owner_id TEXT NOT NULL,
      expires_ms INTEGER NOT NULL, revision INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(kind, id)
    );
    CREATE TABLE IF NOT EXISTS openmatter_store_bindings (binding_key TEXT PRIMARY KEY, session_id TEXT NOT NULL);
  `);
	let closed = false;
	const fail = (message) => {
		throw new StoreError({ message });
	};
	const encode = (value) => {
		if (!Schema.is(JsonValueSchema)(value)) return fail("Store facts must be portable JSON");
		return JSON.stringify(value);
	};
	const read = (sql, ...params) => {
		const row = db.prepare(sql).get(...params);
		return row ? JSON.parse(row.data) : void 0;
	};
	const get = (kind, id) => read("SELECT data FROM openmatter_store_records WHERE kind=? AND id=?", kind, id);
	const rows = (kind, clause = "", params = []) => db.prepare(`SELECT data FROM openmatter_store_records WHERE kind=? ${clause} ORDER BY rowid`).all(kind, ...params).map((row) => JSON.parse(row.data));
	const put = (kind, id, value, scope = null, parent = null, key = null) => {
		db.prepare(`INSERT INTO openmatter_store_records(kind,id,scope_id,parent_id,unique_key,data) VALUES(?,?,?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data, scope_id=excluded.scope_id, parent_id=excluded.parent_id, unique_key=excluded.unique_key`).run(kind, id, scope, parent, key, encode(value));
	};
	const remove = (kind, id) => db.prepare("DELETE FROM openmatter_store_records WHERE kind=? AND id=?").run(kind, id);
	const op = (body, write = false) => Effect.try({
		try: () => {
			if (closed) return fail("SQLite store is closed");
			db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
			try {
				const result = body();
				db.exec("COMMIT");
				return result;
			} catch (cause) {
				db.exec("ROLLBACK");
				throw cause;
			}
		},
		catch: (cause) => cause instanceof StoreError ? cause : new StoreError({
			message: "SQLite store operation failed",
			cause
		})
	});
	const clock = () => Number(db.prepare("SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER) AS now").get().now);
	const leaseRow = (kind, id) => db.prepare("SELECT * FROM openmatter_store_leases WHERE kind=? AND id=?").get(kind, id);
	const asLease = (row) => ({
		token: row.token,
		ownerId: row.owner_id,
		expiresAt: new Date(row.expires_ms).toISOString(),
		revision: row.revision
	});
	const duration = (ms) => {
		if (!Number.isSafeInteger(ms) || ms <= 0) fail("Lease duration must be a positive integer");
		return ms;
	};
	const acquire = (kind, id, request, attempt = 0) => {
		const row = leaseRow(kind, id);
		const next = {
			token: randomUUID(),
			owner_id: request.ownerId,
			expires_ms: clock() + duration(request.durationMs),
			revision: (row?.revision ?? 0) + 1
		};
		db.prepare(`INSERT INTO openmatter_store_leases VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET
      token=excluded.token,owner_id=excluded.owner_id,expires_ms=excluded.expires_ms,revision=excluded.revision,attempt=excluded.attempt`).run(kind, id, next.token, next.owner_id, next.expires_ms, next.revision, attempt);
		return asLease(next);
	};
	const fence = (kind, id, token) => {
		const row = leaseRow(kind, id);
		if (!row || row.token !== token || row.expires_ms <= clock()) return fail(`Invalid, expired or stale ${kind} lease: ${id}`);
		return row;
	};
	const renew = (kind, id, token, ms) => op(() => {
		fence(kind, id, token);
		db.prepare("UPDATE openmatter_store_leases SET expires_ms=? WHERE kind=? AND id=?").run(clock() + duration(ms), kind, id);
	}, true);
	const release = (kind, id) => {
		db.prepare("UPDATE openmatter_store_leases SET expires_ms=0 WHERE kind=? AND id=?").run(kind, id);
	};
	const activeSession = (key) => {
		const row = db.prepare("SELECT session_id FROM openmatter_store_bindings WHERE binding_key=?").get(key);
		return row ? get("session", row.session_id) : void 0;
	};
	const receipt = (eventId) => {
		const reaction = get("reaction", eventId);
		return reaction ? {
			reaction,
			deliveries: reaction.effects.flatMap((effect) => {
				const result = get("delivery", effect.id);
				return result ? [result] : [];
			}),
			duplicate: false
		} : void 0;
	};
	const goalByThread = (workThreadId) => read("SELECT data FROM openmatter_store_records WHERE kind='goal' AND unique_key=?", workThreadId);
	const goalObjective = (objective) => {
		const normalized = objective.trim();
		if (!normalized) fail("Goal objective must not be blank");
		return normalized;
	};
	const goalBudget = (budget) => {
		if (budget !== void 0 && (!Number.isSafeInteger(budget) || budget <= 0)) fail("Goal token budget must be a positive safe integer");
	};
	const requireGoal = (workThreadId, expectedGoalId) => {
		const goal = goalByThread(workThreadId);
		if (!goal) return fail(`No goal for WorkThread ${workThreadId}`);
		if (expectedGoalId !== void 0 && goal.id !== expectedGoalId) fail("Stale goal identity");
		return goal;
	};
	const goalUsageId = (goalId, turnId) => `${goalId}:${turnId}`;
	const removeGoalUsage = (goalId) => db.prepare("DELETE FROM openmatter_store_records WHERE kind='goalUsage' AND parent_id=?").run(goalId);
	const snapshot = (scopeId) => {
		const scopeClause = scopeId === void 0 ? "" : "AND scope_id=?";
		const params = scopeId === void 0 ? [] : [scopeId];
		const contexts = rows("context", scopeClause, params);
		const sessions = rows("session", scopeClause, params);
		const sessionIds = new Set(sessions.map((s) => s.id));
		const turns = rows("turn").filter((t) => scopeId === void 0 || sessionIds.has(t.sessionId));
		const turnIds = new Set(turns.map((t) => t.id));
		const eventIds = /* @__PURE__ */ new Set([...contexts.map((c) => c.triggerEventId), ...turns.map((t) => t.triggerEventId)]);
		const events = rows("event").filter((e) => scopeId === void 0 || eventIds.has(e.id) || e.source.conversationId === scopeId);
		for (const e of events) eventIds.add(e.id);
		const reactions = rows("reaction").filter((r) => scopeId === void 0 || eventIds.has(r.eventId));
		const effectIds = new Set(reactions.flatMap((r) => r.effects.map((e) => e.id)));
		return {
			goals: rows("goal", scopeClause, params),
			contexts,
			sessions,
			turns,
			events,
			reactions,
			deliveries: rows("delivery").filter((d) => scopeId === void 0 || effectIds.has(d.effectId)),
			agentEvents: rows("agentEvent").filter((e) => scopeId === void 0 || turnIds.has(e.turn_id ?? "")),
			permissionDecisions: rows("permission").filter((d) => scopeId === void 0 || turnIds.has(d.turnId)),
			turnCancellationRequests: rows("cancellation").filter((c) => scopeId === void 0 || turnIds.has(c.turnId))
		};
	};
	return {
		close: Effect.try({
			try: () => {
				if (!closed) {
					if (owned) db.close();
					closed = true;
				}
			},
			catch: (cause) => new StoreError({
				message: "Unable to close SQLite store",
				cause
			})
		}),
		inspect: op(() => snapshot()),
		inspectScope: (scope) => op(() => snapshot(scope)),
		createThreadGoal: (input) => op(() => {
			if (!input.scopeId.trim() || !input.workThreadId.trim()) fail("Goal scope and WorkThread identities must not be blank");
			const objective = goalObjective(input.objective);
			goalBudget(input.tokenBudget);
			const existing = goalByThread(input.workThreadId);
			if (existing && existing.scopeId !== input.scopeId) fail("Goal WorkThread belongs to another scope");
			if (existing && existing.status !== "complete") fail("WorkThread already has an unfinished goal");
			const now = new Date(clock()).toISOString();
			const goal = {
				id: randomUUID(),
				scopeId: input.scopeId,
				workThreadId: input.workThreadId,
				objective,
				status: "active",
				...input.tokenBudget === void 0 ? {} : { tokenBudget: input.tokenBudget },
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: now,
				updatedAt: now,
				revision: 1
			};
			if (existing) {
				removeGoalUsage(existing.id);
				remove("goal", existing.id);
			}
			put("goal", goal.id, goal, goal.scopeId, goal.workThreadId, goal.workThreadId);
			return goal;
		}, true),
		getThreadGoal: (workThreadId) => op(() => goalByThread(workThreadId)),
		listThreadGoals: (scopeId) => op(() => scopeId === void 0 ? rows("goal") : rows("goal", "AND scope_id=?", [scopeId])),
		updateThreadGoal: (workThreadId, input) => op(() => {
			const goal = requireGoal(workThreadId, input.expectedGoalId);
			if (input.expectedRevision !== void 0 && input.expectedRevision !== goal.revision) fail("Stale goal revision");
			const objective = input.objective === void 0 ? goal.objective : goalObjective(input.objective);
			const tokenBudget = input.tokenBudget === void 0 ? goal.tokenBudget : input.tokenBudget ?? void 0;
			goalBudget(tokenBudget);
			let status = input.status ?? goal.status;
			if (!Schema.is(ThreadGoalStatusSchema)(status)) fail("Invalid goal status");
			if (status === "active" && tokenBudget !== void 0 && goal.tokensUsed >= tokenBudget) status = "budget_limited";
			const reason = input.reason === void 0 ? input.status === "active" || input.status === "complete" ? void 0 : goal.reason : input.reason.trim() || void 0;
			if (objective === goal.objective && tokenBudget === goal.tokenBudget && status === goal.status && reason === goal.reason) return goal;
			const { tokenBudget: _budget, reason: _reason, ...base } = goal;
			const updated = {
				...base,
				objective,
				status,
				...tokenBudget === void 0 ? {} : { tokenBudget },
				...reason === void 0 ? {} : { reason },
				updatedAt: new Date(clock()).toISOString(),
				revision: goal.revision + 1
			};
			put("goal", goal.id, updated, goal.scopeId, goal.workThreadId, goal.workThreadId);
			return updated;
		}, true),
		accountThreadGoal: (workThreadId, input) => op(() => {
			const goal = requireGoal(workThreadId, input.goalId);
			if (!input.turnId.trim()) fail("Goal usage requires a Turn identity");
			for (const value of [input.tokensUsed, input.timeUsedSeconds]) if (!Number.isSafeInteger(value) || value < 0) fail("Goal usage must be nonnegative safe integers");
			const id = goalUsageId(goal.id, input.turnId);
			const existing = get("goalUsage", id);
			if (existing) {
				if (existing.tokensUsed !== input.tokensUsed || existing.timeUsedSeconds !== input.timeUsedSeconds) fail("Conflicting goal usage for Turn");
				return goal;
			}
			const tokensUsed = goal.tokensUsed + input.tokensUsed;
			const timeUsedSeconds = goal.timeUsedSeconds + input.timeUsedSeconds;
			if (!Number.isSafeInteger(tokensUsed) || !Number.isSafeInteger(timeUsedSeconds)) fail("Goal usage exceeds safe integer range");
			const updated = {
				...goal,
				tokensUsed,
				timeUsedSeconds,
				status: goal.status === "active" && goal.tokenBudget !== void 0 && tokensUsed >= goal.tokenBudget ? "budget_limited" : goal.status,
				updatedAt: new Date(clock()).toISOString(),
				revision: goal.revision + 1
			};
			put("goalUsage", id, input, goal.scopeId, goal.id, id);
			put("goal", goal.id, updated, goal.scopeId, goal.workThreadId, goal.workThreadId);
			return updated;
		}, true),
		clearThreadGoal: (workThreadId, expectedGoalId) => op(() => {
			const goal = goalByThread(workThreadId);
			if (!goal) return false;
			if (expectedGoalId !== void 0 && goal.id !== expectedGoalId) fail("Stale goal identity");
			removeGoalUsage(goal.id);
			remove("goal", goal.id);
			return true;
		}, true),
		claimEvent: (event, request) => op(() => {
			const existing = read("SELECT data FROM openmatter_store_records WHERE kind='event' AND unique_key=?", event.idempotencyKey);
			const fact = existing ?? event;
			const terminal = receipt(fact.id);
			if (terminal) return {
				_tag: "Terminal",
				receipt: terminal
			};
			const current = leaseRow("event", fact.id);
			if (current && current.expires_ms > clock()) return {
				_tag: "Busy",
				lease: asLease(current)
			};
			if (!existing) {
				if (get("event", fact.id)) return fail("Event ID already belongs to a different idempotency key");
				put("event", fact.id, fact, fact.source.conversationId ?? null, null, fact.idempotencyKey);
			}
			return {
				_tag: "Acquired",
				event: fact,
				lease: acquire("event", fact.id, request)
			};
		}, true),
		commitTerminalReaction: (reaction, token) => op(() => {
			fence("event", reaction.eventId, token);
			const existing = get("reaction", reaction.eventId);
			if (existing) return {
				_tag: "Existing",
				reaction: existing
			};
			put("reaction", reaction.eventId, reaction);
			return {
				_tag: "Committed",
				reaction: get("reaction", reaction.eventId)
			};
		}, true),
		renewEventLease: (id, token, request) => renew("event", id, token, request.durationMs),
		getReceipt: (id) => op(() => receipt(id)),
		claimPendingEffects: (request) => op(() => {
			if (!Number.isSafeInteger(request.limit) || request.limit < 0) return fail("Invalid effect claim limit");
			const effects = rows("reaction").filter((r) => request.eventId === void 0 || r.eventId === request.eventId).flatMap((r) => r.effects).sort((a, b) => a.id.localeCompare(b.id));
			const pending = [];
			for (const effect of effects) {
				if (pending.length >= request.limit) break;
				const delivered = get("delivery", effect.id);
				if (delivered && (delivered.status !== "retryable-failed" || delivered.nextRetryAt !== void 0 && Date.parse(delivered.nextRetryAt) > clock())) continue;
				const current = leaseRow("effect", effect.id);
				if (current && current.expires_ms > clock()) continue;
				const previous = db.prepare("SELECT attempt FROM openmatter_store_leases WHERE kind='effect' AND id=?").get(effect.id);
				const attempt = Math.max(previous?.attempt ?? 0, delivered?.attempt ?? 0) + 1;
				pending.push({
					effect,
					attempt,
					lease: acquire("effect", effect.id, request, attempt)
				});
			}
			return pending;
		}, true),
		recordDelivery: (value, token) => op(() => {
			fence("effect", value.effectId, token);
			put("delivery", value.effectId, value);
			release("effect", value.effectId);
		}, true),
		renewEffectLease: (id, token, request) => renew("effect", id, token, request.durationMs),
		claimSession: (key, request) => op(() => {
			const current = leaseRow("session", key);
			if (current && current.expires_ms > clock()) return {
				_tag: "Busy",
				lease: asLease(current)
			};
			const session = activeSession(key);
			return {
				_tag: "Acquired",
				lease: acquire("session", key, request),
				...session ? { session } : {}
			};
		}, true),
		saveSession: (session, token) => op(() => {
			fence("session", session.bindingKey, token);
			const previous = activeSession(session.bindingKey);
			if (previous && previous.id !== session.id && ["open", "creating"].includes(previous.state)) put("session", previous.id, {
				...previous,
				state: "closed"
			}, previous.scopeId, previous.bindingKey);
			put("session", session.id, session, session.scopeId, session.bindingKey);
			db.prepare("INSERT INTO openmatter_store_bindings VALUES(?,?) ON CONFLICT(binding_key) DO UPDATE SET session_id=excluded.session_id").run(session.bindingKey, session.id);
		}, true),
		getSession: (id) => op(() => get("session", id)),
		renewSessionLease: (key, token, request) => renew("session", key, token, request.durationMs),
		releaseSession: (key, token) => op(() => {
			fence("session", key, token);
			release("session", key);
		}, true),
		saveTurn: (turn, key, token) => op(() => {
			fence("session", key, token);
			if (get("session", turn.sessionId)?.bindingKey !== key) return fail("Turn belongs to another session binding");
			const terminal = rows("agentEvent", "AND parent_id=?", [turn.id]).find((e) => [
				"turn.completed",
				"turn.failed",
				"turn.cancelled",
				"turn.interrupted"
			].includes(e.type));
			if (terminal && turn.state !== (terminal.type === "turn.interrupted" ? "cancelled" : terminal.type.slice(5))) return;
			put("turn", turn.id, turn, null, turn.sessionId);
		}, true),
		getTurn: (id) => op(() => get("turn", id)),
		requestTurnCancellation: (key, eventId, at) => op(() => {
			const session = activeSession(key);
			if (!session) return void 0;
			const turn = rows("turn", "AND parent_id=?", [session.id]).filter((t) => ["queued", "running"].includes(t.state)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
			if (!turn) return void 0;
			const existing = get("cancellation", turn.id);
			if (existing) return existing;
			const value = {
				turnId: turn.id,
				sessionId: session.id,
				bindingKey: key,
				requestedByEventId: eventId,
				requestedAt: at
			};
			put("cancellation", turn.id, value);
			return value;
		}, true),
		getTurnCancellation: (id) => op(() => get("cancellation", id)),
		getAgentEvents: (id) => op(() => rows("agentEvent", "AND parent_id=?", [id]).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))),
		getPermissionDecision: (turnId, requestId) => op(() => get("permission", JSON.stringify([turnId, requestId]))),
		commitPermissionDecision: (decision, key, token) => op(() => {
			fence("session", key, token);
			const turn = get("turn", decision.turnId);
			if (!turn || get("session", turn.sessionId)?.bindingKey !== key) return fail("Permission belongs to another session binding");
			const id = JSON.stringify([decision.turnId, decision.requestId]);
			const existing = get("permission", id);
			if (existing) return existing;
			put("permission", id, decision);
			return get("permission", id);
		}, true),
		appendAgentEvent: (event, key, token) => op(() => {
			fence("session", key, token);
			if (!event.turn_id || event.seq === void 0) return fail("Agent event requires turn identity and sequence");
			if (get("session", event.session_id)?.bindingKey !== key || get("turn", event.turn_id)?.sessionId !== event.session_id) return fail("Agent event belongs to another session binding");
			const id = JSON.stringify([event.turn_id, event.seq]);
			const existing = get("agentEvent", id);
			if (existing) {
				if (encode(existing) !== encode(event)) fail("Conflicting Agent event sequence");
				return;
			}
			put("agentEvent", id, event, null, event.turn_id, event.event_id);
		}, true),
		saveContext: (context) => op(() => {
			put("context", context.id, context, context.scopeId, context.workThreadId);
		}, true),
		getContext: (id) => op(() => get("context", id))
	};
};
//#endregion
export { makeSqliteStore };

//# sourceMappingURL=index.js.map
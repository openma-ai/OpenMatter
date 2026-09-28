import { AgentDriverError, AgentDrivers, AgentSessionHandleSchema, OpenMAEventSchema, agentDriverLayer, createOpenMAEvent, immutableJson, isPermissionRequestEvent, isTurnTerminalEvent, turnTerminalStatus } from "@openmatter/agent";
import { ContextProjectionSchema, JsonValueSchema, ReactionSchema, WorkEffectSchema, WorkEventSchema } from "@openmatter/core";
import { IntegrationError, ProviderDeliveryResultSchema, WorkIntegrations, integrationLayer } from "@openmatter/integration";
import { StoreError, StoreService, storeLayer } from "@openmatter/store";
import { Cause, Data, Duration, Effect, Layer, Schema, Stream } from "effect";
//#region src/contracts.ts
var EventBusyError = class extends Data.TaggedError("EventBusyError") {};
var AgentAccessError = class extends Data.TaggedError("AgentAccessError") {};
var ContextProjectionError = class extends Data.TaggedError("ContextProjectionError") {};
var SessionBusyError = class extends Data.TaggedError("SessionBusyError") {};
var AuthorizationError = class extends Data.TaggedError("AuthorizationError") {};
var WorkEventValidationError = class extends Data.TaggedError("WorkEventValidationError") {};
const immutableLoopJson = (value) => {
	const snapshot = structuredClone(value);
	const freeze = (current) => {
		if (current === null || typeof current !== "object") return;
		for (const nested of Array.isArray(current) ? current : Object.values(current)) freeze(nested);
		Object.freeze(current);
	};
	freeze(snapshot);
	return snapshot;
};
const defineLoop = (definition, install) => {
	if (typeof definition.id !== "string" || definition.id.length === 0 || definition.version !== void 0 && typeof definition.version !== "string" || definition.description !== void 0 && typeof definition.description !== "string" || definition.spec !== void 0 && !Schema.is(JsonValueSchema)(definition.spec)) throw new TypeError("Loop definition must contain portable JSON metadata");
	const snapshot = Object.freeze({
		id: definition.id,
		...definition.version === void 0 ? {} : { version: definition.version },
		...definition.description === void 0 ? {} : { description: definition.description },
		...definition.spec === void 0 ? {} : { spec: immutableLoopJson(definition.spec) }
	});
	return Object.freeze({
		definition: snapshot,
		install
	});
};
//#endregion
//#region src/portable-json.ts
const errorMessage = (error) => {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
};
const isJsonObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const sessionHandleFrom = (value) => value !== void 0 && isJsonObject(value) && typeof value.id === "string" ? {
	id: value.id,
	...value.raw === void 0 ? {} : { raw: value.raw }
} : void 0;
const outputFrom = (events) => {
	const messages = events.filter((event) => event.type === "agent.message");
	const complete = [...messages].reverse().find((event) => isJsonObject(event.data) && event.data.phase === "final_answer") ?? [...messages].reverse().find((event) => !isJsonObject(event.data) || event.data.phase !== "commentary") ?? messages.at(-1);
	if (complete !== void 0) {
		if (isJsonObject(complete.data) && complete.data.text !== void 0) return complete.data.text;
		return complete.data;
	}
	const chunks = events.filter((event) => event.type === "agent.message_chunk" && isJsonObject(event.data) && typeof event.data.text === "string");
	if (chunks.length === 0) return void 0;
	const finalChunks = chunks.filter((event) => isJsonObject(event.data) && event.data.phase === "final_answer");
	const nonCommentaryChunks = chunks.filter((event) => isJsonObject(event.data) && event.data.phase !== "commentary");
	let selected = finalChunks.length > 0 ? finalChunks : nonCommentaryChunks.length > 0 ? nonCommentaryChunks : chunks;
	const messageIds = selected.map((event) => isJsonObject(event.data) && typeof event.data.message_id === "string" ? event.data.message_id : void 0);
	if (messageIds.every((id) => id !== void 0)) {
		const latestMessageId = messageIds.at(-1);
		selected = selected.filter((event) => isJsonObject(event.data) && event.data.message_id === latestMessageId);
	}
	return selected.map((event) => isJsonObject(event.data) && typeof event.data.text === "string" ? event.data.text : "").join("");
};
const canonicalize = (value, seen = /* @__PURE__ */ new WeakSet()) => {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number");
		return Object.is(value, -0) ? 0 : value;
	}
	if (typeof value !== "object") throw new TypeError(`Unsupported JSON value: ${typeof value}`);
	if (seen.has(value)) throw new TypeError("Cyclic JSON value");
	seen.add(value);
	if (Array.isArray(value)) {
		const result = value.map((entry) => canonicalize(entry, seen));
		seen.delete(value);
		return result;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Only plain JSON objects can be canonicalized");
	const result = Object.fromEntries(Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0).map((key) => [key, canonicalize(value[key], seen)]));
	seen.delete(value);
	return result;
};
const canonicalJson = (value) => {
	const encoded = JSON.stringify(canonicalize(value));
	if (encoded === void 0) throw new TypeError("Value is not JSON data");
	return encoded;
};
const digest = (value) => Effect.tryPromise({
	try: async () => {
		const encoded = new TextEncoder().encode(canonicalJson(value));
		return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", encoded))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	},
	catch: (cause) => new ContextProjectionError({
		message: "Context projection is not serializable",
		cause
	})
});
//#endregion
//#region src/agent-turn.ts
const makeAgentTurnRuntime = (options) => {
	const bindingKeyFor = (agentId, authority, scopeId, workThreadId, privacyPartition) => JSON.stringify([
		agentId,
		authority,
		scopeId,
		workThreadId,
		privacyPartition
	]);
	const decidePermission = (request) => Effect.suspend(() => {
		if (options.permissionPolicy === void 0) return Effect.succeed(false);
		try {
			const decision = options.permissionPolicy(request);
			if (Effect.isEffect(decision)) return decision.pipe(Effect.mapError((cause) => new AgentDriverError({
				message: "Permission policy failed",
				cause
			})));
			if (decision instanceof Promise) return Effect.tryPromise({
				try: () => decision,
				catch: (cause) => new AgentDriverError({
					message: "Permission policy failed",
					cause
				})
			});
			return Effect.succeed(decision);
		} catch (cause) {
			return Effect.fail(new AgentDriverError({
				message: "Permission policy failed",
				cause
			}));
		}
	}).pipe(Effect.flatMap((decision) => typeof decision === "boolean" ? Effect.succeed(decision) : Effect.fail(new AgentDriverError({ message: "Permission policy must return a boolean decision" }))));
	const run = (event, agentId, authority, scopeId, workThreadId, privacyPartition, turnId, input) => Effect.suspend(() => {
		let activeSessionLease;
		let activeTurn;
		return Effect.gen(function* () {
			const store = yield* StoreService;
			const drivers = yield* AgentDrivers;
			if (input.context.scopeId !== scopeId || input.context.workThreadId !== workThreadId) return yield* new ContextProjectionError({ message: "Context projection does not match the agent session binding" });
			const bindingKey = bindingKeyFor(agentId, authority, scopeId, workThreadId, privacyPartition);
			const sessionClaim = yield* store.claimSession(bindingKey, options.lease.request(options.sessionLeaseMs));
			if (sessionClaim._tag === "Busy") return yield* new SessionBusyError({
				bindingKey,
				retryAt: sessionClaim.lease.expiresAt,
				message: `Agent session is busy: ${bindingKey}`
			});
			activeSessionLease = {
				bindingKey,
				token: sessionClaim.lease.token
			};
			const claimedSession = Effect.gen(function* () {
				const storedTurn = yield* store.getTurn(turnId);
				const storedEvents = yield* store.getAgentEvents(turnId);
				const storedTerminal = storedEvents.find(isTurnTerminalEvent);
				if (storedTerminal !== void 0) {
					if (storedTurn === void 0) return yield* new StoreError({ message: `Terminal Agent events exist without Turn state: ${turnId}` });
					const storedSession = yield* store.getSession(storedTurn.sessionId);
					if (storedSession === void 0) return yield* new StoreError({ message: `Turn references an unknown Agent Session: ${turnId}` });
					const outcome = turnTerminalStatus(storedTerminal);
					const completedTurn = {
						...storedTurn,
						state: outcome === "interrupted" ? "cancelled" : outcome,
						completedAt: storedTurn.completedAt ?? storedTerminal.occurred_at
					};
					if (storedTurn.state !== completedTurn.state || storedTurn.completedAt === void 0) yield* store.saveTurn(completedTurn, bindingKey, sessionClaim.lease.token);
					return {
						session: storedSession,
						turn: completedTurn,
						outcome,
						events: storedEvents,
						output: outputFrom(storedEvents)
					};
				}
				const interruptStoredTurn = (turn, reason) => Effect.gen(function* () {
					const originalSession = yield* store.getSession(turn.sessionId);
					if (originalSession === void 0) return yield* new StoreError({ message: `Partial Turn references an unknown Agent Session: ${turn.id}` });
					const sequence = (storedEvents.at(-1)?.seq ?? 0) + 1;
					const interruptedEvent = createOpenMAEvent({
						event_id: `${turn.id}:runtime-interrupted:${sequence}`,
						type: "turn.interrupted",
						session_id: turn.sessionId,
						turn_id: turn.id,
						seq: sequence,
						occurred_at: options.clock(),
						source: {
							kind: "openma",
							adapter: "runtime"
						},
						data: { reason }
					});
					yield* store.appendAgentEvent(interruptedEvent, bindingKey, sessionClaim.lease.token);
					const interruptedTurn = {
						...turn,
						state: "cancelled",
						completedAt: interruptedEvent.occurred_at
					};
					yield* store.saveTurn(interruptedTurn, bindingKey, sessionClaim.lease.token);
					return {
						session: originalSession,
						turn: interruptedTurn,
						outcome: "interrupted",
						events: [...storedEvents, interruptedEvent],
						output: outputFrom(storedEvents)
					};
				});
				if (storedTurn?.state === "cancelled") return yield* interruptStoredTurn(storedTurn, "A previously cancelled Agent Turn cannot be resumed");
				const driver = drivers.get(agentId);
				if (driver === void 0) {
					if (storedTurn !== void 0) return yield* interruptStoredTurn(storedTurn, "The configured Agent Driver is unavailable for this in-flight Turn");
					return yield* new AgentAccessError({
						agentId,
						message: `Unknown agent: ${agentId}`
					});
				}
				const capabilities = yield* driver.capabilities();
				const turnContext = yield* store.getContext(storedTurn?.contextProjectionId ?? input.context.id);
				if (turnContext === void 0) return yield* new StoreError({ message: `Logical Turn references an unknown ContextProjection: ${turnId}` });
				const expectedContextDigest = storedTurn?.contextDigest ?? input.context.digest;
				if (turnContext.digest !== expectedContextDigest) return yield* new StoreError({ message: `Logical Turn context digest no longer matches: ${turnId}` });
				const turnAllow = storedTurn?.allow ?? input.allow ?? [];
				const denied = turnAllow.find((operation) => !turnContext.grants.includes(operation));
				if (denied !== void 0) return yield* new AuthorizationError({
					operation: denied,
					message: `Turn operation is not present in the context grants: ${denied}`
				});
				const portableHandle = (handle) => {
					if (!Schema.is(AgentSessionHandleSchema)(handle)) return Effect.fail(new AgentDriverError({ message: "Agent Session handle must be portable JSON data" }));
					const storedHandle = {
						id: handle.id,
						...handle.raw === void 0 ? {} : { raw: handle.raw }
					};
					return Effect.succeed(storedHandle);
				};
				const realizePlannedSession = (planned) => Effect.gen(function* () {
					const handle = yield* driver.createSession({
						sessionId: planned.id,
						scopeId: planned.scopeId,
						workThreadId: planned.workThreadId,
						bindingKey,
						generation: planned.generation,
						idempotencyKey: planned.id
					});
					const externalHandle = yield* portableHandle(handle);
					const session = {
						...planned,
						externalHandle,
						state: "open",
						lastUsedAt: options.clock()
					};
					yield* store.saveSession(session, sessionClaim.lease.token);
					return {
						session,
						handle
					};
				});
				const createGeneration = (previous) => Effect.gen(function* () {
					const now = options.clock();
					const planned = {
						id: options.makeId(),
						bindingKey,
						agentId,
						authority,
						scopeId,
						workThreadId,
						privacyPartition,
						driverId: driver.id,
						generation: (previous?.generation ?? 0) + 1,
						state: "creating",
						createdAt: now,
						lastUsedAt: now
					};
					yield* store.saveSession(planned, sessionClaim.lease.token);
					return yield* realizePlannedSession(planned);
				});
				const existing = sessionClaim.session;
				const existingHandle = sessionHandleFrom(existing?.externalHandle);
				const canResumeExisting = existing !== void 0 && existing.driverId === driver.id && existing.state === "open" && existingHandle !== void 0 && capabilities.resume;
				const hasInFlightTurn = storedTurn !== void 0;
				if (hasInFlightTurn && (!canResumeExisting || existing.id !== storedTurn.sessionId)) {
					if (existing?.id === storedTurn.sessionId) yield* store.saveSession({
						...existing,
						state: "interrupted",
						lastUsedAt: options.clock()
					}, sessionClaim.lease.token);
					return yield* interruptStoredTurn(storedTurn, "The original Agent Session cannot resume this in-flight Turn");
				}
				let prepared;
				if (existing !== void 0 && existing.driverId === driver.id && existing.state === "creating") prepared = yield* realizePlannedSession(existing);
				else if (canResumeExisting) {
					const resumed = yield* driver.resumeSession(existingHandle).pipe(Effect.map((handle) => ({
						_tag: "Resumed",
						handle
					})), Effect.catchTag("AgentSessionUnavailableError", () => Effect.succeed({ _tag: "Unavailable" })));
					if (resumed._tag === "Unavailable") {
						yield* store.saveSession({
							...existing,
							state: "expired",
							lastUsedAt: options.clock()
						}, sessionClaim.lease.token);
						if (hasInFlightTurn) return yield* interruptStoredTurn(storedTurn, "The remote Agent Session expired during an in-flight Turn");
						prepared = yield* createGeneration(existing);
					} else {
						const externalHandle = yield* portableHandle(resumed.handle);
						const session = {
							...existing,
							externalHandle,
							state: "open",
							lastUsedAt: options.clock()
						};
						yield* store.saveSession(session, sessionClaim.lease.token);
						prepared = {
							session,
							handle: resumed.handle
						};
					}
				} else {
					if (existing !== void 0 && existing.driverId === driver.id && existing.state === "open" && existingHandle !== void 0) yield* driver.closeSession(existingHandle);
					if (existing !== void 0) yield* store.saveSession({
						...existing,
						state: existing.state === "expired" ? "expired" : "closed",
						lastUsedAt: options.clock()
					}, sessionClaim.lease.token);
					prepared = yield* createGeneration(existing);
				}
				const { session, handle } = prepared;
				const now = options.clock();
				const runningTurn = {
					id: turnId,
					sessionId: session.id,
					triggerEventId: event.id,
					contextProjectionId: storedTurn?.contextProjectionId ?? input.context.id,
					contextDigest: storedTurn?.contextDigest ?? input.context.digest,
					allow: turnAllow,
					state: "running",
					createdAt: storedTurn?.createdAt ?? now
				};
				yield* store.saveTurn(runningTurn, bindingKey, sessionClaim.lease.token);
				activeTurn = runningTurn;
				if ((yield* store.getTurnCancellation(turnId)) !== void 0) {
					if (capabilities.cancel) yield* driver.cancel({
						session: handle,
						turnId
					});
					const sequence = (storedEvents.at(-1)?.seq ?? 0) + 1;
					const cancelledEvent = createOpenMAEvent({
						event_id: `${turnId}:runtime-cancelled:${sequence}`,
						type: "turn.cancelled",
						session_id: session.id,
						turn_id: turnId,
						seq: sequence,
						occurred_at: options.clock(),
						source: {
							kind: "openma",
							adapter: "runtime"
						},
						data: { reason: "Cancellation requested by a WorkEvent" }
					});
					yield* store.appendAgentEvent(cancelledEvent, bindingKey, sessionClaim.lease.token);
					const cancelledTurn = {
						...runningTurn,
						state: "cancelled",
						completedAt: cancelledEvent.occurred_at
					};
					yield* store.saveTurn(cancelledTurn, bindingKey, sessionClaim.lease.token);
					activeTurn = void 0;
					return {
						session,
						turn: cancelledTurn,
						outcome: "cancelled",
						events: [...storedEvents, cancelledEvent],
						output: outputFrom(storedEvents)
					};
				}
				const lastSequence = storedEvents.at(-1)?.seq ?? 0;
				const interpreted = driver.turn({
					session: handle,
					sessionId: session.id,
					turnId,
					afterSequence: lastSequence,
					context: turnContext,
					allow: turnAllow
				}).pipe(Stream.runFoldEffect({
					expectedSequence: lastSequence + 1,
					events: storedEvents,
					terminal: void 0
				}, (state, agentEvent) => Effect.gen(function* () {
					if (!Schema.is(OpenMAEventSchema)(agentEvent)) return yield* new AgentDriverError({ message: "Agent emitted an invalid OpenMAEvent" });
					const durableEvent = yield* Effect.try({
						try: () => immutableJson(agentEvent),
						catch: (cause) => new AgentDriverError({
							message: "Agent emitted an OpenMAEvent that is not an immutable JSON fact",
							cause
						})
					});
					if (state.terminal !== void 0) return yield* new AgentDriverError({ message: "Agent emitted an event after its terminal event" });
					if (durableEvent.session_id !== session.id || durableEvent.turn_id !== turnId) return yield* new AgentDriverError({ message: "Agent event does not match the active session and turn" });
					if (!Number.isInteger(durableEvent.seq) || durableEvent.seq !== state.expectedSequence) return yield* new AgentDriverError({ message: `Agent event sequence mismatch: expected ${state.expectedSequence}, received ${durableEvent.seq}` });
					if (isPermissionRequestEvent(durableEvent)) {
						if (!capabilities.permissions) return yield* new AgentDriverError({ message: "Agent requested permission but its driver does not support permission responses" });
						const requestId = durableEvent.data.callback_id;
						const requestFingerprint = durableEvent.data.fingerprint;
						const storedDecision = yield* store.getPermissionDecision(turnId, requestId);
						if (storedDecision !== void 0 && storedDecision.requestFingerprint !== requestFingerprint) return yield* new AgentDriverError({ message: `Permission request content changed for reused request id: ${requestId}` });
						const decision = storedDecision ?? (yield* decidePermission({
							agentId,
							requestId,
							event: durableEvent,
							context: turnContext
						}).pipe(Effect.flatMap((approved) => store.commitPermissionDecision({
							turnId,
							requestId,
							requestFingerprint,
							approved,
							decidedAt: options.clock()
						}, bindingKey, sessionClaim.lease.token))));
						yield* driver.respondToPermission({
							session: handle,
							requestId,
							approved: decision.approved
						});
					}
					const terminal = isTurnTerminalEvent(durableEvent) ? durableEvent : void 0;
					if (terminal === void 0) yield* store.appendAgentEvent(durableEvent, bindingKey, sessionClaim.lease.token);
					return {
						expectedSequence: state.expectedSequence + 1,
						events: terminal === void 0 ? [...state.events, durableEvent] : state.events,
						terminal
					};
				})), Effect.flatMap((state) => {
					if (state.terminal === void 0) return Effect.fail(new AgentDriverError({ message: "Agent stream ended without a terminal event" }));
					return Effect.succeed({
						...state,
						terminal: state.terminal
					});
				}), Effect.onExit((exit) => exit._tag === "Failure" ? store.saveTurn({
					...runningTurn,
					state: Cause.isInterrupted(exit.cause) ? "cancelled" : "failed",
					completedAt: options.clock()
				}, bindingKey, sessionClaim.lease.token).pipe(Effect.catchAll(() => Effect.void)) : Effect.void), Effect.onInterrupt(() => capabilities.cancel ? store.getTurnCancellation(turnId).pipe(Effect.flatMap((requested) => requested === void 0 ? driver.cancel({
					session: handle,
					turnId
				}) : Effect.void), Effect.catchAll(() => Effect.void)) : Effect.void));
				const waitForCancellation = () => store.getTurnCancellation(turnId).pipe(Effect.flatMap((requested) => requested === void 0 ? Effect.sleep("50 millis").pipe(Effect.zipRight(waitForCancellation())) : Effect.succeed(requested)));
				const cancelled = waitForCancellation().pipe(Effect.flatMap(() => store.getAgentEvents(turnId)), Effect.map((durableEvents) => {
					const sequence = (durableEvents.at(-1)?.seq ?? 0) + 1;
					const terminal = createOpenMAEvent({
						event_id: `${turnId}:runtime-cancelled:${sequence}`,
						type: "turn.cancelled",
						session_id: session.id,
						turn_id: turnId,
						seq: sequence,
						occurred_at: options.clock(),
						source: {
							kind: "openma",
							adapter: "runtime"
						},
						data: { reason: "Cancellation requested by a WorkEvent" }
					});
					return {
						expectedSequence: sequence + 1,
						events: durableEvents,
						terminal
					};
				}));
				const streamState = yield* Effect.raceFirst(interpreted, cancelled);
				yield* store.appendAgentEvent(streamState.terminal, bindingKey, sessionClaim.lease.token);
				const events = [...streamState.events, streamState.terminal];
				const outcome = turnTerminalStatus(streamState.terminal);
				const turn = {
					...runningTurn,
					state: outcome === "interrupted" ? "cancelled" : outcome,
					completedAt: options.clock()
				};
				yield* store.saveTurn(turn, bindingKey, sessionClaim.lease.token);
				activeTurn = void 0;
				return {
					session,
					turn,
					outcome,
					events,
					output: outputFrom(events)
				};
			});
			return yield* options.lease.withHeartbeat(claimedSession, options.sessionLeaseMs, (renewal) => store.renewSessionLease(bindingKey, sessionClaim.lease.token, renewal));
		}).pipe(Effect.onInterrupt(() => {
			if (activeSessionLease === void 0 || activeTurn === void 0) return Effect.void;
			return StoreService.pipe(Effect.flatMap((store) => store.saveTurn({
				...activeTurn,
				state: "cancelled",
				completedAt: options.clock()
			}, activeSessionLease.bindingKey, activeSessionLease.token)), Effect.catchAll(() => Effect.void));
		}), Effect.ensuring(Effect.suspend(() => {
			if (activeSessionLease === void 0) return Effect.void;
			return StoreService.pipe(Effect.flatMap((store) => store.releaseSession(activeSessionLease.bindingKey, activeSessionLease.token)), Effect.catchAll(() => Effect.void));
		})));
	});
	const cancel = (event, agentId, authority, scopeId, workThreadId, privacyPartition) => Effect.gen(function* () {
		const store = yield* StoreService;
		const drivers = yield* AgentDrivers;
		const bindingKey = bindingKeyFor(agentId, authority, scopeId, workThreadId, privacyPartition);
		const cancellation = yield* store.requestTurnCancellation(bindingKey, event.id, options.clock());
		if (cancellation === void 0) return { status: "idle" };
		const session = yield* store.getSession(cancellation.sessionId);
		if (session === void 0) return yield* new StoreError({ message: `Cancellation references an unknown Agent Session: ${cancellation.sessionId}` });
		const driver = drivers.get(agentId);
		if (driver === void 0 || session.driverId !== driver.id) return yield* new AgentAccessError({
			agentId,
			message: `Unable to cancel unavailable agent: ${agentId}`
		});
		const handle = sessionHandleFrom(session.externalHandle);
		if (handle === void 0) return yield* new AgentDriverError({ message: "Stored Agent Session has no resumable cancellation handle" });
		if (!(yield* driver.capabilities()).cancel) return yield* new AgentDriverError({ message: `Agent Driver does not support cancellation: ${agentId}` });
		yield* driver.cancel({
			session: handle,
			turnId: cancellation.turnId
		});
		return {
			status: "requested",
			turnId: cancellation.turnId
		};
	});
	return {
		cancel,
		run
	};
};
//#endregion
//#region src/lease.ts
const makeLeaseRuntime = (input) => {
	const renewal = (durationMs) => ({ durationMs });
	return {
		request: (durationMs) => ({
			ownerId: input.runtimeId,
			durationMs
		}),
		withHeartbeat: (operation, durationMs, renew) => {
			const intervalMs = Math.max(1, Math.floor(durationMs / 3));
			const heartbeat = Effect.forever(Effect.sleep(Duration.millis(intervalMs)).pipe(Effect.zipRight(Effect.suspend(() => renew(renewal(durationMs))))));
			return Effect.raceFirst(operation, heartbeat);
		}
	};
};
//#endregion
//#region src/index.ts
const ReactionDraftSchema = Schema.Struct({
	status: Schema.Literal("completed", "failed", "cancelled"),
	effects: Schema.Array(WorkEffectSchema),
	reason: Schema.optional(Schema.String)
});
const compileHandlerFailure = (error) => {
	if (error instanceof AgentDriverError || error instanceof SessionBusyError || error instanceof StoreError) return Effect.fail(error);
	return Effect.succeed({
		status: "failed",
		effects: [],
		reason: errorMessage(error)
	});
};
const createOpenMatter = (options) => {
	const handlers = /* @__PURE__ */ new Map();
	const clock = options.clock ?? (() => (/* @__PURE__ */ new Date()).toISOString());
	const makeId = options.makeId ?? (() => globalThis.crypto.randomUUID());
	const runtimeId = options.runtimeId ?? makeId();
	const services = Layer.mergeAll(storeLayer(options.store), integrationLayer(options.integrations), agentDriverLayer(options.agents));
	const lease = makeLeaseRuntime({ runtimeId });
	const { request: leaseRequest, withHeartbeat: withLeaseHeartbeat } = lease;
	const agentTurns = makeAgentTurnRuntime({
		clock,
		makeId,
		lease,
		sessionLeaseMs: options.sessionLeaseMs ?? 3e5,
		...options.permissionPolicy === void 0 ? {} : { permissionPolicy: options.permissionPolicy }
	});
	const runAgentTurn = agentTurns.run;
	const cancelAgentTurn = agentTurns.cancel;
	const makeWorkContext = (event, store, drivers, integrations) => {
		let effectSequence = 0;
		let agentTurnSequence = 0;
		const projectedContexts = /* @__PURE__ */ new Map();
		const authorizedEffects = /* @__PURE__ */ new Map();
		const authorizeContext = (context, operation) => {
			const authorization = projectedContexts.get(context.id);
			return !Schema.is(ContextProjectionSchema)(context) || authorization === void 0 || authorization !== canonicalJson(context) ? Effect.fail(new AuthorizationError({
				operation,
				message: `ContextProjection was not authorized by this work event: ${context.id}`
			})) : Effect.void;
		};
		return {
			api: {
				event,
				context: {
					event: () => ({
						id: event.id,
						kind: "event",
						value: event,
						provenance: [{
							sourceType: "work-event",
							sourceId: event.id,
							integrationId: event.source.provider
						}]
					}),
					value: (input) => ({
						id: input.id ?? makeId(),
						kind: input.kind,
						value: input.value,
						provenance: input.provenance
					}),
					project: (input) => {
						const snapshot = structuredClone({
							scopeId: input.scopeId,
							workThreadId: input.workThreadId,
							items: input.items,
							grants: input.grants ?? []
						});
						return Effect.gen(function* () {
							const contextDigest = yield* digest({
								scopeId: snapshot.scopeId,
								workThreadId: snapshot.workThreadId,
								triggerEventId: event.id,
								items: snapshot.items,
								grants: snapshot.grants
							});
							const projection = {
								schemaVersion: "0.1",
								id: makeId(),
								scopeId: snapshot.scopeId,
								workThreadId: snapshot.workThreadId,
								triggerEventId: event.id,
								items: snapshot.items,
								grants: snapshot.grants,
								digest: contextDigest,
								createdAt: clock()
							};
							yield* store.saveContext(projection);
							projectedContexts.set(projection.id, canonicalJson(projection));
							return projection;
						});
					}
				},
				effect: (context, input) => {
					const contextSnapshot = structuredClone(context);
					const effectInput = structuredClone(input);
					return Effect.gen(function* () {
						yield* authorizeContext(contextSnapshot, effectInput.operation);
						const durableContext = yield* store.getContext(contextSnapshot.id);
						if (durableContext === void 0) return yield* new AuthorizationError({
							operation: effectInput.operation,
							message: `ContextProjection is not durable: ${contextSnapshot.id}`
						});
						if (!Schema.is(JsonValueSchema)(effectInput.input)) return yield* new AuthorizationError({
							operation: effectInput.operation,
							message: "WorkEffect input must be portable JSON data"
						});
						const capability = `${effectInput.integrationId}.${effectInput.operation}`;
						if (!durableContext.grants.includes(capability)) return yield* new AuthorizationError({
							operation: capability,
							message: `Effect operation is not authorized by context grants: ${capability}`
						});
						const integration = integrations.get(effectInput.integrationId);
						if (integration === void 0) return yield* new AuthorizationError({
							operation: effectInput.operation,
							message: `Effect targets an unknown integration: ${effectInput.integrationId}`
						});
						if (!integration.manifest.operations.includes("*") && !integration.manifest.operations.includes(effectInput.operation)) return yield* new AuthorizationError({
							operation: effectInput.operation,
							message: `Integration does not declare operation: ${effectInput.operation}`
						});
						effectSequence += 1;
						const effect = {
							schemaVersion: "0.1",
							id: makeId(),
							eventId: event.id,
							integrationId: effectInput.integrationId,
							operation: effectInput.operation,
							idempotencyKey: effectInput.idempotencyKey ?? `${event.idempotencyKey}:effect:${effectSequence}`,
							input: effectInput.input
						};
						authorizedEffects.set(effect.id, canonicalJson(effect));
						return effect;
					});
				},
				react: {
					none: (reason) => ({
						status: "completed",
						effects: [],
						...reason === void 0 ? {} : { reason }
					}),
					effects: (effects, reason) => ({
						status: "completed",
						effects,
						...reason === void 0 ? {} : { reason }
					})
				},
				agent: (agentId) => ({ session: ({ scopeId, workThreadId, authority = event.source.authority, privacyPartition }) => ({
					cancel: () => cancelAgentTurn(event, agentId, authority, scopeId, workThreadId, privacyPartition).pipe(Effect.provideService(StoreService, store), Effect.provideService(AgentDrivers, drivers)),
					turn: (input) => {
						const invocation = ++agentTurnSequence;
						const sealedInput = structuredClone({
							context: input.context,
							allow: input.allow ?? []
						});
						return authorizeContext(sealedInput.context, "agent.turn").pipe(Effect.zipRight(digest({
							eventIdempotencyKey: event.idempotencyKey,
							agentId,
							authority,
							scopeId,
							workThreadId,
							privacyPartition,
							invocation
						})), Effect.flatMap((turnDigest) => runAgentTurn(event, agentId, authority, scopeId, workThreadId, privacyPartition, `turn:${turnDigest}`, sealedInput)), Effect.provideService(StoreService, store), Effect.provideService(AgentDrivers, drivers));
					}
				}) })
			},
			authorizeDraft: (draft) => {
				if (!Schema.is(ReactionDraftSchema)(draft)) return Effect.fail(new AuthorizationError({
					operation: "reaction.commit",
					message: "ReactionDraft must be a portable terminal value"
				}));
				return Effect.forEach(draft.effects, (effect) => {
					const authorization = authorizedEffects.get(effect.id);
					if (!Schema.is(WorkEffectSchema)(effect) || authorization === void 0 || authorization !== canonicalJson(effect)) return Effect.fail(new AuthorizationError({
						operation: effect.operation,
						message: `WorkEffect was not authorized by this runtime: ${effect.id}`
					}));
					return Effect.void;
				}).pipe(Effect.as(structuredClone(draft)));
			}
		};
	};
	const normalizeHandler = (handler, work) => Effect.suspend(() => {
		try {
			const result = handler(work);
			if (Effect.isEffect(result)) return result;
			if (result instanceof Promise) return Effect.tryPromise({
				try: () => result,
				catch: (cause) => cause
			});
			return Effect.succeed(result);
		} catch (cause) {
			return Effect.fail(cause);
		}
	});
	const reactionFrom = (event, draft) => ({
		schemaVersion: "0.1",
		id: makeId(),
		eventId: event.id,
		status: draft.status,
		effects: draft.effects,
		...draft.reason === void 0 ? {} : { reason: draft.reason },
		createdAt: clock()
	});
	const terminalReactionFrom = (event, draft) => {
		const candidate = reactionFrom(event, draft);
		return Schema.is(ReactionSchema)(candidate) ? candidate : reactionFrom(event, {
			status: "failed",
			effects: [],
			reason: "ReactionDraft must produce a portable terminal Reaction"
		});
	};
	const deliverPending = (input) => Effect.gen(function* () {
		const store = yield* StoreService;
		const integrations = yield* WorkIntegrations;
		const pending = yield* store.claimPendingEffects({
			...leaseRequest(options.effectLeaseMs ?? 6e4),
			limit: input.limit,
			...input.eventId === void 0 ? {} : { eventId: input.eventId }
		});
		return yield* Effect.forEach(pending, ({ effect, lease, attempt }) => {
			const integration = integrations.get(effect.integrationId);
			const delivery = integration === void 0 ? Effect.succeed({
				effectId: effect.id,
				integrationId: effect.integrationId,
				operation: effect.operation,
				status: "terminal-failed",
				attempt,
				attemptedAt: clock(),
				error: `Unknown integration: ${effect.integrationId}`
			}) : integration.deliver(effect).pipe(Effect.flatMap((result) => {
				if (!Schema.is(ProviderDeliveryResultSchema)(result)) return Effect.fail(new IntegrationError({
					message: "Provider delivery result must contain only portable JSON data",
					retryable: false
				}));
				return Effect.succeed({
					effectId: effect.id,
					integrationId: effect.integrationId,
					operation: effect.operation,
					status: "delivered",
					attempt,
					attemptedAt: clock(),
					...result.providerReceipt === void 0 ? {} : { providerReceipt: result.providerReceipt }
				});
			}), Effect.catchAll((error) => {
				const attemptedAt = clock();
				return Effect.succeed({
					effectId: effect.id,
					integrationId: effect.integrationId,
					operation: effect.operation,
					status: error.retryable ? "retryable-failed" : "terminal-failed",
					attempt,
					attemptedAt,
					...error.retryable ? { nextRetryAt: error.retryAt !== void 0 && Number.isFinite(Date.parse(error.retryAt)) ? new Date(Date.parse(error.retryAt)).toISOString() : new Date(Date.parse(attemptedAt) + (options.effectRetryDelayMs ?? 1e3)).toISOString() } : {},
					error: error.message
				});
			}));
			return withLeaseHeartbeat(delivery.pipe(Effect.flatMap((receipt) => store.recordDelivery(receipt, lease.token).pipe(Effect.as(receipt)))), options.effectLeaseMs ?? 6e4, (renewal) => store.renewEffectLease(effect.id, lease.token, renewal));
		}, { concurrency: options.effectConcurrency ?? "unbounded" });
	});
	const acceptProgram = (event) => Effect.gen(function* () {
		const eventId = typeof event === "object" && event !== null && "id" in event && typeof event.id === "string" ? event.id : void 0;
		if (!Schema.is(WorkEventSchema)(event)) return yield* new WorkEventValidationError({
			...eventId === void 0 ? {} : { eventId },
			message: "WorkEvent must be portable JSON data"
		});
		const store = yield* StoreService;
		const integrations = yield* WorkIntegrations;
		const drivers = yield* AgentDrivers;
		const claim = yield* store.claimEvent(event, leaseRequest(options.eventLeaseMs ?? 6e4));
		if (claim._tag === "Busy") return yield* new EventBusyError({
			eventId: event.id,
			retryAt: claim.lease.expiresAt,
			message: `Event is already being processed: ${event.id}`
		});
		if (claim._tag === "Terminal") {
			yield* deliverPending({
				eventId: claim.receipt.reaction.eventId,
				limit: 100
			}).pipe(Effect.provideService(StoreService, store), Effect.provideService(WorkIntegrations, integrations));
			const refreshed = yield* store.getReceipt(claim.receipt.reaction.eventId);
			return {
				reaction: claim.receipt.reaction,
				deliveries: refreshed?.deliveries ?? claim.receipt.deliveries,
				duplicate: true
			};
		}
		const workEvent = claim.event;
		const handler = handlers.get(workEvent.type) ?? handlers.get("*");
		const work = makeWorkContext(workEvent, store, drivers, integrations);
		const handlerProgram = handler === void 0 ? Effect.succeed({
			status: "completed",
			effects: [],
			reason: `No handler registered for ${workEvent.type}`
		}) : normalizeHandler(handler, work.api).pipe(Effect.flatMap(work.authorizeDraft), Effect.catchAll(compileHandlerFailure));
		const eventLeaseMs = options.eventLeaseMs ?? 6e4;
		const reaction = yield* withLeaseHeartbeat(handlerProgram.pipe(Effect.flatMap((draft) => {
			const reaction = terminalReactionFrom(workEvent, draft);
			return store.commitTerminalReaction(reaction, claim.lease.token).pipe(Effect.map((commit) => commit.reaction));
		}), Effect.onInterrupt(() => store.commitTerminalReaction(terminalReactionFrom(workEvent, {
			status: "cancelled",
			effects: [],
			reason: "Execution interrupted"
		}), claim.lease.token).pipe(Effect.catchAll(() => Effect.void)))), eventLeaseMs, (renewal) => store.renewEventLease(workEvent.id, claim.lease.token, renewal));
		yield* deliverPending({
			eventId: reaction.eventId,
			limit: 100
		}).pipe(Effect.provideService(StoreService, store), Effect.provideService(WorkIntegrations, integrations));
		return {
			reaction,
			deliveries: (yield* store.getReceipt(reaction.eventId))?.deliveries ?? [],
			duplicate: false
		};
	});
	const acceptEffect = (event) => acceptProgram(event).pipe(Effect.provide(services));
	const recoverEffectsEffect = (recoverOptions) => deliverPending({ limit: recoverOptions?.limit ?? 100 }).pipe(Effect.provide(services));
	const acceptFromProgram = (integrationId, input) => Effect.gen(function* () {
		const integration = (yield* WorkIntegrations).get(integrationId);
		if (integration === void 0) return yield* new IntegrationError({
			message: `Unknown integration: ${integrationId}`,
			retryable: false
		});
		const events = yield* integration.ingest(input);
		return yield* Effect.forEach(events, acceptProgram, { concurrency: 1 });
	});
	const acceptFromEffect = (integrationId, input) => acceptFromProgram(integrationId, input).pipe(Effect.provide(services));
	const app = {
		loop: (loop) => {
			loop.install(app);
			return app;
		},
		on: (eventTypes, handler) => {
			const types = typeof eventTypes === "string" ? [eventTypes] : eventTypes;
			for (const type of types) handlers.set(type, handler);
			return app;
		},
		acceptEffect,
		accept: (event) => Effect.runPromise(acceptEffect(event)),
		recoverEffectsEffect,
		recoverEffects: (recoverOptions) => Effect.runPromise(recoverEffectsEffect(recoverOptions)),
		acceptFromEffect,
		acceptFrom: (integrationId, input) => Effect.runPromise(acceptFromEffect(integrationId, input)),
		consume: (events, consumeOptions) => Effect.runPromise(Stream.fromAsyncIterable(events, (cause) => cause).pipe(Stream.mapEffect(acceptEffect, { concurrency: consumeOptions?.concurrency ?? 1 }), Stream.runFold({
			processed: 0,
			failed: 0,
			duplicates: 0
		}, (summary, receipt) => ({
			processed: summary.processed + 1,
			failed: summary.failed + (receipt.reaction.status === "failed" ? 1 : 0),
			duplicates: summary.duplicates + (receipt.duplicate ? 1 : 0)
		}))))
	};
	return app;
};
//#endregion
export { AgentAccessError, AuthorizationError, ContextProjectionError, EventBusyError, SessionBusyError, WorkEventValidationError, createOpenMatter, defineLoop };

//# sourceMappingURL=index.js.map
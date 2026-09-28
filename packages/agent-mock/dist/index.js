import { createOpenMAEvent } from "@openmatter/agent";
import { Effect, Stream } from "effect";
//#region src/index.ts
const makeMockAgentDriver = (options) => {
	let nextSession = 1;
	const permissionResponses = [];
	const cancelledTurns = [];
	const sessionsByIdempotencyKey = /* @__PURE__ */ new Map();
	return {
		driver: {
			id: options.id,
			capabilities: () => Effect.succeed({
				resume: options.resume ?? true,
				cancel: true,
				permissions: true,
				concurrentTurns: false
			}),
			createSession: ({ idempotencyKey }) => Effect.sync(() => {
				const existing = sessionsByIdempotencyKey.get(idempotencyKey);
				if (existing !== void 0) return existing;
				const created = { id: `${options.id}-session-${nextSession++}` };
				sessionsByIdempotencyKey.set(idempotencyKey, created);
				return created;
			}),
			resumeSession: (handle) => Effect.succeed(handle),
			turn: (input) => {
				if (options.neverComplete) return Stream.never;
				const timestamp = (/* @__PURE__ */ new Date()).toISOString();
				const events = [
					...options.permissionRequestId === void 0 ? [] : [createOpenMAEvent({
						event_id: `${input.turnId}:permission`,
						session_id: input.sessionId,
						turn_id: input.turnId,
						seq: 1,
						type: "callback.requested",
						occurred_at: timestamp,
						source: {
							kind: "harness",
							harness: options.id
						},
						data: {
							callback_id: options.permissionRequestId,
							fingerprint: `${input.turnId}:${options.permissionRequestId}`,
							method: "permission.request",
							category: "permission"
						}
					})],
					createOpenMAEvent({
						event_id: `${input.turnId}:output`,
						session_id: input.sessionId,
						turn_id: input.turnId,
						seq: options.permissionRequestId === void 0 ? 1 : 2,
						type: "agent.message",
						occurred_at: timestamp,
						source: {
							kind: "harness",
							harness: options.id
						},
						data: { text: options.output }
					}),
					...options.omitTerminal ? [] : [createOpenMAEvent({
						event_id: `${input.turnId}:terminal`,
						session_id: input.sessionId,
						turn_id: input.turnId,
						seq: options.permissionRequestId === void 0 ? 2 : 3,
						type: options.terminalType ?? "turn.completed",
						occurred_at: timestamp,
						source: {
							kind: "harness",
							harness: options.id
						},
						data: {}
					})]
				];
				return Stream.fromIterable(events.filter((event) => (event.seq ?? 0) > input.afterSequence));
			},
			respondToPermission: ({ requestId, approved }) => Effect.sync(() => {
				permissionResponses.push({
					requestId,
					approved
				});
			}),
			cancel: ({ turnId }) => Effect.sync(() => {
				cancelledTurns.push(turnId);
			}),
			closeSession: () => Effect.void
		},
		permissionResponses: () => [...permissionResponses],
		cancelledTurns: () => [...cancelledTurns],
		createdSessions: () => nextSession - 1
	};
};
//#endregion
export { makeMockAgentDriver };

//# sourceMappingURL=index.js.map
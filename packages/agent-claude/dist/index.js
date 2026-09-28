import { createAgentSessionHandle, immutableJson } from "@openma/common/agent-contract";
import { AgentDriverError, AgentSessionUnavailableError, OpenMAEventSchema } from "@openmatter/agent";
import { Effect, Schema, Stream } from "effect";
//#region src/index.ts
const driverError = (message, cause) => new AgentDriverError({
	message,
	cause
});
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const durableHandleFrom = (handle) => {
	if (!isRecord(handle.raw) || handle.raw.schemaVersion !== "openmatter.connector-handle.v1" || typeof handle.raw.sessionId !== "string" || typeof handle.raw.idempotencyKey !== "string" || !Number.isSafeInteger(handle.raw.generation) || !isRecord(handle.raw.connector)) throw new TypeError("Agent Session handle does not contain an OpenMA connector handle");
	const { connectorId, externalSessionId, placement, resumeToken, metadata } = handle.raw.connector;
	if (typeof connectorId !== "string" || typeof externalSessionId !== "string" || ![
		"local",
		"remote",
		"managed"
	].includes(String(placement)) || resumeToken !== void 0 && typeof resumeToken !== "string" || metadata !== void 0 && !isRecord(metadata)) throw new TypeError("Agent Session handle is not a valid OpenMA connector handle");
	const portableConnector = createAgentSessionHandle({
		connectorId,
		externalSessionId,
		placement,
		...resumeToken === void 0 ? {} : { resumeToken },
		...metadata === void 0 ? {} : { metadata }
	});
	return immutableJson({
		schemaVersion: "openmatter.connector-handle.v1",
		sessionId: handle.raw.sessionId,
		idempotencyKey: handle.raw.idempotencyKey,
		generation: handle.raw.generation,
		connector: portableConnector
	});
};
const connectorHandleFrom = (handle) => durableHandleFrom(handle).connector;
const driverHandleFrom = (handle, identity) => {
	const portable = createAgentSessionHandle(handle);
	const stored = immutableJson({
		schemaVersion: "openmatter.connector-handle.v1",
		...identity,
		connector: portable
	});
	return {
		id: identity.sessionId,
		raw: stored
	};
};
const defaultContent = (context) => JSON.stringify({
	scopeId: context.scopeId,
	workThreadId: context.workThreadId,
	items: context.items,
	grants: context.grants
});
const validateConnectorEvent = (event) => {
	if (!Schema.is(OpenMAEventSchema)(event)) return Effect.fail(new AgentDriverError({ message: "Claude Agent Connector emitted an invalid OpenMAEvent" }));
	return Effect.try({
		try: () => immutableJson(event),
		catch: (cause) => driverError("Claude Agent Connector emitted a non-immutable OpenMAEvent", cause)
	});
};
const validateConnectorCapabilities = (value) => Effect.try({
	try: () => {
		if (!isRecord(value)) throw new TypeError("capabilities must be an object");
		if (![
			"ephemeral",
			"resumable",
			"persistent"
		].includes(String(value.sessionPersistence))) throw new TypeError("sessionPersistence is invalid");
		for (const field of [
			"streaming",
			"cancellation",
			"permissions",
			"elicitation"
		]) if (typeof value[field] !== "boolean") throw new TypeError(`${field} must be boolean`);
		for (const field of [
			"steering",
			"customTools",
			"mcp"
		]) if (value[field] !== void 0 && typeof value[field] !== "boolean") throw new TypeError(`${field} must be boolean when present`);
		if (value.extensions !== void 0) {
			if (!isRecord(value.extensions)) throw new TypeError("extensions must be a JSON object when present");
			immutableJson(value.extensions);
		}
		return value;
	},
	catch: (cause) => driverError("Claude Agent Connector returned invalid capabilities", cause)
});
const makeClaudeAgentDriver = (options) => {
	const connector = options.connector;
	const projectContent = options.content ?? defaultContent;
	const unavailable = options.isSessionUnavailable ?? (() => false);
	const resumeError = (cause) => {
		try {
			return unavailable(cause) ? new AgentSessionUnavailableError({
				message: "Claude Agent Session is unavailable",
				cause
			}) : driverError("Could not resume Claude Agent Session", cause);
		} catch (classifierCause) {
			return driverError("Claude Agent Session availability classifier failed", classifierCause);
		}
	};
	const capabilities = () => Effect.tryPromise({
		try: () => connector.capabilities(),
		catch: (cause) => driverError("Could not read Claude Agent capabilities", cause)
	}).pipe(Effect.flatMap(validateConnectorCapabilities), Effect.map((value) => ({
		resume: value.sessionPersistence !== "ephemeral",
		cancel: value.cancellation,
		permissions: value.permissions,
		concurrentTurns: false
	})));
	return {
		id: options.id ?? connector.id,
		capabilities,
		createSession: (input) => Effect.tryPromise({
			try: async () => driverHandleFrom(await connector.open({
				sessionId: input.sessionId,
				idempotencyKey: input.idempotencyKey,
				generation: input.generation,
				agentId: options.agentId,
				...options.session?.cwd === void 0 ? {} : { cwd: options.session.cwd },
				...options.session?.additionalDirectories === void 0 ? {} : { additionalDirectories: options.session.additionalDirectories },
				...options.session?.metadata === void 0 ? {} : { metadata: immutableJson(options.session.metadata) }
			}), {
				sessionId: input.sessionId,
				idempotencyKey: input.idempotencyKey,
				generation: input.generation
			}),
			catch: (cause) => driverError("Could not create Claude Agent Session", cause)
		}),
		resumeSession: (handle) => Effect.tryPromise({
			try: async () => {
				const stored = durableHandleFrom(handle);
				const resumed = await connector.open({
					sessionId: stored.sessionId,
					idempotencyKey: stored.idempotencyKey,
					generation: stored.generation,
					agentId: options.agentId,
					resume: stored.connector,
					...options.session?.cwd === void 0 ? {} : { cwd: options.session.cwd },
					...options.session?.additionalDirectories === void 0 ? {} : { additionalDirectories: options.session.additionalDirectories },
					...options.session?.metadata === void 0 ? {} : { metadata: immutableJson(options.session.metadata) }
				});
				return driverHandleFrom(resumed, stored);
			},
			catch: resumeError
		}),
		turn: (input) => Stream.unwrap(Effect.try({
			try: () => ({
				session: connectorHandleFrom(input.session),
				content: immutableJson(projectContent(input.context))
			}),
			catch: (cause) => driverError("Could not prepare Claude Agent Turn", cause)
		}).pipe(Effect.flatMap(({ session, content }) => Effect.try({
			try: () => {
				const events = connector.execute(session, {
					sessionId: input.sessionId,
					turnId: input.turnId,
					afterSequence: input.afterSequence,
					contextDigest: input.context.digest,
					content,
					grants: input.allow
				});
				if (events === null || typeof events !== "object" || typeof events[Symbol.asyncIterator] !== "function") throw new TypeError("Claude Agent Connector execute() must return an AsyncIterable");
				return events;
			},
			catch: (cause) => driverError("Claude Agent Turn stream failed", cause)
		}).pipe(Effect.map((events) => Stream.fromAsyncIterable(events, (cause) => driverError("Claude Agent Turn stream failed", cause)).pipe(Stream.mapEffect(validateConnectorEvent), Stream.filter((event) => event.seq === void 0 || event.seq > input.afterSequence))))))),
		respondToPermission: ({ session, requestId, approved }) => Effect.tryPromise({
			try: () => connector.send(connectorHandleFrom(session), {
				type: "callback.respond",
				callbackId: requestId,
				result: { approved }
			}),
			catch: (cause) => driverError("Could not answer Claude Agent permission", cause)
		}),
		cancel: ({ session, turnId }) => Effect.tryPromise({
			try: () => connector.send(connectorHandleFrom(session), {
				type: "turn.cancel",
				turnId
			}),
			catch: (cause) => driverError("Could not cancel Claude Agent Turn", cause)
		}),
		closeSession: (session) => Effect.tryPromise({
			try: () => connector.close(connectorHandleFrom(session)),
			catch: (cause) => driverError("Could not close Claude Agent Session", cause)
		})
	};
};
//#endregion
export { makeClaudeAgentDriver };

//# sourceMappingURL=index.js.map
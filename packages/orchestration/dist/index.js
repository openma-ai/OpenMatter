import { defineLoop } from "@openmatter/runtime";
import { Effect } from "effect";
//#region src/linear-agent-surface.ts
const isRecord$1 = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const stringAt = (value, key) => {
	const candidate = value?.[key];
	return typeof candidate === "string" && candidate.length > 0 ? candidate : void 0;
};
const activityIntent = (input, eventId, content, ephemeral, modifiers = {}) => ({
	integrationId: "linear",
	operation: "agent.activity.create",
	idempotencyKey: `linear:${input.agentSessionId}:openma:${eventId}`,
	input: {
		organizationId: input.organizationId,
		appUserId: input.appUserId,
		...input.oauthClientId === void 0 ? {} : { oauthClientId: input.oauthClientId },
		agentSessionId: input.agentSessionId,
		content,
		ephemeral,
		...modifiers.signal === void 0 ? {} : { signal: modifiers.signal },
		...modifiers.signalMetadata === void 0 ? {} : { signalMetadata: modifiers.signalMetadata }
	}
});
const sessionIntent = (input, eventId, changes) => ({
	integrationId: "linear",
	operation: "agent.session.update",
	idempotencyKey: `linear:${input.agentSessionId}:openma:${eventId}`,
	input: {
		organizationId: input.organizationId,
		appUserId: input.appUserId,
		...input.oauthClientId === void 0 ? {} : { oauthClientId: input.oauthClientId },
		agentSessionId: input.agentSessionId,
		...changes
	}
});
const linearPlanStatus = (status) => status === "in_progress" ? "inProgress" : String(status ?? "pending");
const planFrom = (data) => {
	if (!Array.isArray(data.entries)) return void 0;
	return { steps: data.entries.flatMap((entry) => {
		if (!isRecord$1(entry) || typeof entry.content !== "string") return [];
		return [{
			...typeof entry.id === "string" ? { id: entry.id } : {},
			label: entry.content,
			status: linearPlanStatus(entry.status)
		}];
	}) };
};
const elicitationBody = (data) => {
	const params = isRecord$1(data.params) ? data.params : void 0;
	return stringAt(params, "body") ?? stringAt(params, "prompt") ?? stringAt(params, "title") ?? "Agent needs additional input";
};
const elicitationModifiers = (data) => {
	const params = isRecord$1(data.params) ? data.params : void 0;
	const signal = stringAt(params, "signal");
	const metadata = isRecord$1(params?.signalMetadata) ? params.signalMetadata : void 0;
	if (signal === "auth" && metadata !== void 0) {
		const url = stringAt(metadata, "url");
		if (url === void 0) return {};
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return {};
		} catch {
			return {};
		}
		return {
			signal: "auth",
			signalMetadata: {
				url,
				...stringAt(metadata, "userId") === void 0 ? {} : { userId: stringAt(metadata, "userId") },
				...stringAt(metadata, "providerName") === void 0 ? {} : { providerName: stringAt(metadata, "providerName") }
			}
		};
	}
	if (signal === "select" && metadata !== void 0 && Array.isArray(metadata.options)) {
		const options = metadata.options.slice(0, 20).flatMap((option) => {
			if (!isRecord$1(option)) return [];
			const value = stringAt(option, "value");
			const label = stringAt(option, "label");
			if (value === void 0) return [];
			return [{
				...label === void 0 ? {} : { label },
				value
			}];
		});
		if (options.length === 0) return {};
		return {
			signal: "select",
			signalMetadata: { options }
		};
	}
	return {};
};
/**
* Explicit GUI projection for Linear's Agent Surface.
*
* OpenMA events stay the durable runtime facts. This function emits only the
* finite Linear operations that an application may authorize. Raw tool
* inputs/outputs and private thinking text are deliberately never copied.
*/
const projectLinearAgentSurface = (input) => {
	const projected = [];
	const activeTools = /* @__PURE__ */ new Map();
	let projectedThinking = false;
	let lastMessage;
	const messageChunks = /* @__PURE__ */ new Map();
	let lastChunkMessageId;
	for (const event of input.events) {
		const data = isRecord$1(event.data) ? event.data : {};
		switch (event.type) {
			case "agent.thinking":
				if (!projectedThinking) {
					projected.push(activityIntent(input, event.event_id, {
						type: "thought",
						body: "Working…"
					}, true));
					projectedThinking = true;
				}
				break;
			case "tool.started": {
				const toolCallId = stringAt(data, "tool_call_id");
				if (toolCallId !== void 0) activeTools.set(toolCallId, {
					eventId: event.event_id,
					data
				});
				break;
			}
			case "tool.completed":
			case "tool.failed":
			case "tool.cancelled": {
				const toolCallId = stringAt(data, "tool_call_id");
				const started = toolCallId === void 0 ? void 0 : activeTools.get(toolCallId);
				const title = stringAt(data, "title") ?? stringAt(started?.data, "title") ?? "Agent action";
				const toolName = stringAt(data, "tool_name") ?? stringAt(started?.data, "tool_name") ?? stringAt(data, "kind") ?? stringAt(started?.data, "kind") ?? "tool";
				const result = event.type === "tool.completed" ? "Completed" : event.type === "tool.cancelled" ? "Cancelled" : "Failed";
				projected.push(activityIntent(input, event.event_id, {
					type: "action",
					action: title,
					parameter: toolName,
					result
				}, true));
				if (toolCallId !== void 0) activeTools.delete(toolCallId);
				break;
			}
			case "callback.requested":
				if (data.category === "elicitation") projected.push(activityIntent(input, event.event_id, {
					type: "elicitation",
					body: elicitationBody(data)
				}, false, elicitationModifiers(data)));
				break;
			case "plan.updated": {
				const plan = planFrom(data);
				if (plan !== void 0) projected.push(sessionIntent(input, event.event_id, { plan }));
				break;
			}
			case "plan.removed":
				projected.push(sessionIntent(input, event.event_id, { plan: { steps: [] } }));
				break;
			case "agent.message": {
				const text = stringAt(data, "text");
				if (text !== void 0) lastMessage = {
					eventId: event.event_id,
					text
				};
				break;
			}
			case "agent.message_chunk": {
				const text = stringAt(data, "text");
				if (text === void 0) break;
				const messageId = stringAt(data, "message_id") ?? "default";
				const accumulated = messageChunks.get(messageId)?.text ?? "";
				messageChunks.set(messageId, {
					eventId: event.event_id,
					text: `${accumulated}${text}`
				});
				lastChunkMessageId = messageId;
				break;
			}
			case "turn.failed":
			case "turn.cancelled":
			case "turn.interrupted": {
				const body = event.type === "turn.cancelled" ? "Agent work was cancelled" : event.type === "turn.interrupted" ? "Agent work was interrupted" : "Agent work failed";
				projected.push(activityIntent(input, event.event_id, {
					type: "error",
					body
				}, false));
				break;
			}
		}
	}
	if (lastMessage === void 0 && lastChunkMessageId !== void 0) lastMessage = messageChunks.get(lastChunkMessageId);
	if (lastMessage !== void 0) projected.push(activityIntent(input, lastMessage.eventId, {
		type: "response",
		body: lastMessage.text
	}, false));
	if (input.externalUrls !== void 0 && input.externalUrls.length > 0) {
		const lastEvent = input.events.at(-1);
		projected.push(sessionIntent(input, lastEvent?.event_id ?? "external-urls", { addedExternalUrls: input.externalUrls }));
	}
	const maximum = Math.max(1, Math.floor(input.maxActivities ?? 12));
	const activityIndexes = projected.flatMap((intent, index) => intent.operation === "agent.activity.create" ? [index] : []);
	if (activityIndexes.length <= maximum) return projected;
	const keptActivities = /* @__PURE__ */ new Set([...activityIndexes.slice(0, maximum - 1), activityIndexes.at(-1)]);
	return projected.filter((intent, index) => intent.operation !== "agent.activity.create" || keptActivities.has(index));
};
const loadContext$1 = (loader, work) => Effect.suspend(() => {
	try {
		const result = loader(work);
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
const loadExternalUrls = (source, input) => Effect.suspend(() => {
	try {
		if (typeof source !== "function") return Effect.succeed(source);
		const result = source(input);
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
const surfaceBinding = (work) => {
	if (!isRecord$1(work.event.payload)) throw new Error("Linear Agent Surface requires an event payload");
	const organizationId = work.event.source.authority;
	const agentSessionId = stringAt(work.event.payload, "agentSessionId");
	const appUserId = stringAt(work.event.payload, "appUserId");
	const oauthClientId = stringAt(work.event.payload, "oauthClientId");
	if (agentSessionId === void 0 || appUserId === void 0) throw new Error("Linear Agent Surface requires agentSessionId and appUserId");
	const scopeId = `linear:${organizationId}:app:${appUserId}`;
	return {
		organizationId,
		agentSessionId,
		appUserId,
		...oauthClientId === void 0 ? {} : { oauthClientId },
		scopeId,
		workThreadId: `linear:${organizationId}:agent-session:${agentSessionId}`
	};
};
const installLinearAgentSurface = (app, options) => {
	const additionalContext = (work) => options.context === void 0 ? Effect.succeed([]) : loadContext$1(options.context, work);
	app.on("linear.agent-session.accepted", (work) => Effect.gen(function* () {
		const binding = surfaceBinding(work);
		const extra = yield* additionalContext(work);
		const context = yield* work.context.project({
			scopeId: binding.scopeId,
			workThreadId: binding.workThreadId,
			items: [work.context.event(), ...extra],
			grants: ["linear.agent.activity.create"]
		});
		const accepted = yield* work.effect(context, {
			integrationId: "linear",
			operation: "agent.activity.create",
			idempotencyKey: `linear:${binding.agentSessionId}:surface:accepted`,
			input: {
				organizationId: binding.organizationId,
				appUserId: binding.appUserId,
				...binding.oauthClientId === void 0 ? {} : { oauthClientId: binding.oauthClientId },
				agentSessionId: binding.agentSessionId,
				content: {
					type: "thought",
					body: options.initialThought ?? "Starting work…"
				},
				ephemeral: true
			}
		});
		return work.react.effects([accepted]);
	}));
	const run = (work) => Effect.gen(function* () {
		const binding = surfaceBinding(work);
		const extra = yield* additionalContext(work);
		const context = yield* work.context.project({
			scopeId: binding.scopeId,
			workThreadId: binding.workThreadId,
			items: [work.context.event(), ...extra],
			grants: ["linear.agent.activity.create", "linear.agent.session.update"]
		});
		const turn = yield* work.agent(options.agentId).session({
			scopeId: binding.scopeId,
			workThreadId: binding.workThreadId,
			authority: binding.organizationId,
			privacyPartition: binding.scopeId
		}).turn({
			context,
			allow: context.grants
		});
		const urls = options.externalUrls === void 0 ? void 0 : yield* loadExternalUrls(options.externalUrls, {
			work,
			turn
		});
		const intents = projectLinearAgentSurface({
			organizationId: binding.organizationId,
			appUserId: binding.appUserId,
			...binding.oauthClientId === void 0 ? {} : { oauthClientId: binding.oauthClientId },
			agentSessionId: binding.agentSessionId,
			events: turn.events,
			...options.maxActivities === void 0 ? {} : { maxActivities: options.maxActivities },
			...urls === void 0 ? {} : { externalUrls: urls }
		});
		const effects = yield* Effect.forEach(intents, (intent) => work.effect(context, intent));
		return work.react.effects(effects);
	});
	app.on("linear.agent-session.created", run);
	app.on("linear.agent-session.prompted", run);
	app.on("linear.agent-session.stop-requested", (work) => Effect.gen(function* () {
		const binding = surfaceBinding(work);
		const cancellation = yield* work.agent(options.agentId).session({
			scopeId: binding.scopeId,
			workThreadId: binding.workThreadId,
			authority: binding.organizationId,
			privacyPartition: binding.scopeId
		}).cancel();
		const context = yield* work.context.project({
			scopeId: binding.scopeId,
			workThreadId: binding.workThreadId,
			items: [work.context.event()],
			grants: ["linear.agent.activity.create"]
		});
		const response = yield* work.effect(context, {
			integrationId: "linear",
			operation: "agent.activity.create",
			idempotencyKey: `linear:${binding.agentSessionId}:surface:stop:${work.event.id}`,
			input: {
				organizationId: binding.organizationId,
				appUserId: binding.appUserId,
				...binding.oauthClientId === void 0 ? {} : { oauthClientId: binding.oauthClientId },
				agentSessionId: binding.agentSessionId,
				content: {
					type: "response",
					body: cancellation.status === "requested" ? "Stopping work…" : "There is no active work to stop."
				},
				ephemeral: false
			}
		});
		return work.react.effects([response]);
	}));
	return app;
};
const linearAgentSurface = (options) => defineLoop({
	id: "linear-agent-surface",
	version: "0.1.0",
	description: "Project one private Agent runtime into Linear's Agent Session GUI",
	spec: {
		integration: "linear",
		sources: [
			"linear.agent-session.accepted",
			"linear.agent-session.created",
			"linear.agent-session.prompted",
			"linear.agent-session.stop-requested"
		],
		association: {
			scope: "linear.organization-app-identity",
			workThread: "linear.agent-session"
		},
		agent: {
			id: options.agentId,
			session: "per-work-thread"
		},
		surfaceProjection: "explicit-de-sensitive-bounded",
		reaction: "terminal-per-event"
	}
}, (app) => installLinearAgentSurface(app, options));
//#endregion
//#region src/coordinator-loop.ts
const resolve = (thunk) => Effect.suspend(() => {
	try {
		const result = thunk();
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
const assertAssociation = (continuity, association) => {
	if (association.scopeId.length === 0) return Effect.fail(/* @__PURE__ */ new TypeError("Coordinator scopeId must not be empty"));
	if (continuity === "per-run" && (association.runId === void 0 || association.runId.length === 0)) return Effect.fail(/* @__PURE__ */ new TypeError("Coordinator runId must not be empty for per-run continuity"));
	if (association.thread.kind === "worker" && association.thread.id.length === 0) return Effect.fail(/* @__PURE__ */ new TypeError("Coordinator worker id must not be empty"));
	return Effect.succeed(association);
};
const workThreadIdFor = (loopId, continuity, association) => {
	const prefix = continuity === "per-run" ? `${loopId}:run:${association.runId}` : loopId;
	return association.thread.kind === "coordinator" ? `${prefix}:coordinator` : `${prefix}:worker:${association.thread.id}`;
};
const associationItem = (work, loopId, association) => work.context.value({
	id: association.thread.kind === "coordinator" ? `${loopId}:association:coordinator` : `${loopId}:association:worker:${association.thread.id}`,
	kind: "coordinator-association",
	value: {
		role: association.thread.kind,
		scopeId: association.scopeId,
		...association.runId === void 0 ? {} : { runId: association.runId },
		...association.thread.kind === "worker" ? { workerId: association.thread.id } : {}
	},
	provenance: [{
		sourceType: "loop-definition",
		sourceId: loopId
	}]
});
/**
* Reusable coordinator/worker Loop with Scope- or Run-scoped continuity.
*
* The Loop owns durable association and context projection. Delegation remains
* an explicit Event: an Agent tool or application emits an event that
* `associate` maps to a named worker, so no hidden workflow runtime is added.
*/
const makeCoordinatorLoop = (options, pattern) => {
	const sources = typeof options.sources === "string" ? [options.sources] : options.sources;
	const grants = [...options.grants ?? []];
	const controls = [...options.controls ?? ["delegate"]];
	const cancelSources = new Set(options.cancelSources === void 0 ? [] : typeof options.cancelSources === "string" ? [options.cancelSources] : options.cancelSources);
	const workerAgent = options.workerAgent;
	const workerAgentDefinition = workerAgent === void 0 ? options.agentId : typeof workerAgent === "string" ? workerAgent : "extension:worker-agent";
	return defineLoop({
		id: options.id,
		...options.version === void 0 ? {} : { version: options.version },
		description: options.description ?? "Coordinate durable work across Agent Sessions",
		spec: {
			preset: "coordinator-loop",
			...pattern === void 0 ? {} : { pattern },
			sources,
			...options.goal === void 0 ? {} : { goal: options.goal },
			association: {
				scope: "application-defined",
				continuity: options.continuity,
				workThread: {
					coordinator: options.continuity === "per-run" ? "one-per-scope-and-run" : "one-per-scope",
					worker: options.continuity === "per-run" ? "one-per-scope-run-and-worker-id" : "one-per-scope-and-worker-id"
				}
			},
			agents: {
				coordinator: options.agentId,
				worker: workerAgentDefinition,
				sessions: "isolated-by-work-thread"
			},
			controls: {
				scope: "bound-by-host",
				commands: controls,
				exposure: "agent-driver-binding",
				...cancelSources.size === 0 ? {} : { cancelSources: [...cancelSources] }
			},
			context: options.context === void 0 ? "event+coordinator-association" : "event+coordinator-association+extension:context",
			grants,
			reaction: options.effects === void 0 ? "terminal-none" : "terminal-effects"
		}
	}, (app) => app.on(sources, (work) => Effect.gen(function* () {
		const association = yield* resolve(() => options.associate(work)).pipe(Effect.flatMap((association) => assertAssociation(options.continuity, association)));
		if (options.admit && !(yield* resolve(() => options.admit({
			work,
			association
		})))) return work.react.none("Host deferred or superseded this continuation");
		const agentIdFor = (target) => {
			if (target.thread.kind === "coordinator" || workerAgent === void 0) return Effect.succeed(options.agentId);
			if (typeof workerAgent === "string") return Effect.succeed(workerAgent);
			return resolve(() => workerAgent({
				work,
				association: target
			}));
		};
		const runProjectTurn = (target, resultItems = []) => Effect.gen(function* () {
			const agentId = yield* agentIdFor(target);
			if (agentId.trim().length === 0) return yield* Effect.fail(/* @__PURE__ */ new TypeError("Coordinator agent id must not be empty"));
			const workThreadId = workThreadIdFor(options.id, options.continuity, target);
			const additionalContext = options.context === void 0 ? [] : yield* resolve(() => options.context({
				work,
				association: target
			}));
			const goal = options.goal === void 0 ? [] : [work.context.value({
				id: `${options.id}:goal`,
				kind: "coordinator-goal",
				value: options.goal,
				provenance: [{
					sourceType: "loop-definition",
					sourceId: options.id
				}]
			})];
			const context = yield* work.context.project({
				scopeId: target.scopeId,
				workThreadId,
				items: [
					work.context.event(),
					...goal,
					associationItem(work, options.id, target),
					...additionalContext,
					...resultItems
				],
				grants
			});
			const turn = yield* work.agent(agentId).session({
				scopeId: target.scopeId,
				workThreadId,
				...target.authority === void 0 ? {} : { authority: target.authority },
				privacyPartition: target.privacyPartition ?? target.scopeId
			}).turn({
				context,
				allow: grants
			});
			if (options.onTurnFinished) yield* resolve(() => options.onTurnFinished({
				work,
				association: target,
				context,
				turn
			}));
			return {
				context,
				turn
			};
		});
		let workerTurn;
		let completed;
		if (association.thread.kind === "worker" && cancelSources.has(work.event.type)) {
			const workerAgentId = yield* agentIdFor(association);
			const cancellation = yield* work.agent(workerAgentId).session({
				scopeId: association.scopeId,
				workThreadId: workThreadIdFor(options.id, options.continuity, association),
				...association.authority === void 0 ? {} : { authority: association.authority },
				privacyPartition: association.privacyPartition ?? association.scopeId
			}).cancel();
			completed = yield* runProjectTurn({
				...association,
				thread: { kind: "coordinator" }
			}, [work.context.value({
				id: `${options.id}:worker-cancellation:${association.thread.id}`,
				kind: "coordinator-worker-cancellation",
				value: {
					workerId: association.thread.id,
					status: cancellation.status,
					...cancellation.turnId === void 0 ? {} : { turnId: cancellation.turnId }
				},
				provenance: [{
					sourceType: "work-event",
					sourceId: work.event.id
				}]
			})]);
		} else {
			const first = yield* runProjectTurn(association);
			if (association.thread.kind === "coordinator") completed = first;
			else {
				workerTurn = first.turn;
				completed = yield* runProjectTurn({
					...association,
					thread: { kind: "coordinator" }
				}, [work.context.value({
					id: `${options.id}:worker-result:${association.thread.id}`,
					kind: "coordinator-worker-result",
					value: {
						workerId: association.thread.id,
						outcome: first.turn.outcome,
						...first.turn.output === void 0 ? {} : { output: first.turn.output }
					},
					provenance: [{
						sourceType: "agent-turn",
						sourceId: first.turn.turn.id
					}]
				})]);
			}
		}
		if (options.effects === void 0) return work.react.none("Coordinator Turn completed without effects");
		const planned = yield* resolve(() => options.effects({
			work,
			association,
			turn: completed.turn,
			...workerTurn === void 0 ? {} : { workerTurn }
		}));
		const intents = planned === null || planned === void 0 ? [] : Array.isArray(planned) ? planned : [planned];
		const effects = yield* Effect.forEach(intents, (intent) => work.effect(completed.context, intent));
		return effects.length === 0 ? work.react.none("Coordinator Turn completed without effects") : work.react.effects(effects);
	})));
};
const coordinatorLoop = (options) => makeCoordinatorLoop(options);
/** Linear-inspired built-in pattern: each activation Run owns its Session. */
const linearLoop = (options) => makeCoordinatorLoop({
	...options,
	continuity: "per-run",
	description: options.description ?? "Run a Linear-style coordinator with isolated Run continuity"
}, "linear-loop");
//#endregion
//#region src/index.ts
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const outputText = (output) => typeof output === "string" ? output : JSON.stringify(output ?? null);
const loadContext = (loader, work) => Effect.suspend(() => {
	try {
		const result = loader(work);
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
const installClaudeTagHandlers = (app, options) => {
	const integrationId = "slack";
	const projectAndTurn = (work, scopeId, workThreadId, grant) => Effect.gen(function* () {
		const additionalContext = options.context === void 0 ? [] : yield* loadContext(options.context, work);
		const context = yield* work.context.project({
			scopeId,
			workThreadId,
			items: [work.context.event(), ...additionalContext],
			grants: [grant]
		});
		return {
			context,
			turn: yield* work.agent(options.agentId).session({
				scopeId,
				workThreadId,
				privacyPartition: scopeId
			}).turn({
				context,
				allow: context.grants
			})
		};
	});
	const handleMessage = (work) => Effect.gen(function* () {
		if (!isRecord(work.event.payload)) throw new Error("Claude Tag requires a Slack message payload");
		const { activation, channelId, contextTeamId, messageTs, threadTs, surface } = work.event.payload;
		if (work.event.type === `${integrationId}.message.received` && activation !== "direct") return work.react.none("Claude Tag only auto-activates on direct messages");
		if (typeof channelId !== "string" || typeof messageTs !== "string" || typeof threadTs !== "string" || surface !== "channel" && surface !== "dm") throw new Error("Claude Tag requires channelId, messageTs, threadTs, and surface");
		const scopeId = `${integrationId}:${work.event.source.authority}:${surface}:${channelId}`;
		const isDmConversation = surface === "dm" && threadTs === messageTs;
		const operation = isDmConversation ? "message.post" : "message.reply";
		const workThreadId = isDmConversation ? `${integrationId}:${work.event.source.authority}:${channelId}:dm` : `${integrationId}:${work.event.source.authority}:${channelId}:thread:${threadTs}`;
		const { context, turn } = yield* projectAndTurn(work, scopeId, workThreadId, `${integrationId}.${operation}`);
		const reply = yield* work.effect(context, {
			integrationId,
			operation,
			input: {
				teamId: work.event.source.authority,
				channelId,
				...typeof contextTeamId === "string" ? { clientContextTeamId: contextTeamId } : {},
				...operation === "message.reply" ? { threadTs } : {},
				text: outputText(turn.output)
			}
		});
		return work.react.effects([reply]);
	});
	const handleCommand = (work) => Effect.gen(function* () {
		if (!isRecord(work.event.payload)) throw new Error("Claude Tag requires a Slack command payload");
		const { channelId, surface, triggerId, userId } = work.event.payload;
		if (typeof channelId !== "string" || typeof triggerId !== "string" || typeof userId !== "string" || surface !== "channel" && surface !== "dm") throw new Error("Claude Tag command requires channelId, userId, triggerId, and surface");
		const commandOperation = options.commandVisibility === "channel" ? "message.post" : "message.ephemeral";
		const scopeId = `${integrationId}:${work.event.source.authority}:${surface}:${channelId}`;
		const workThreadId = `${integrationId}:${work.event.source.authority}:${channelId}:command:${triggerId}`;
		const { context, turn } = yield* projectAndTurn(work, scopeId, workThreadId, `${integrationId}.${commandOperation}`);
		const reply = yield* work.effect(context, {
			integrationId,
			operation: commandOperation,
			input: {
				teamId: work.event.source.authority,
				channelId,
				...commandOperation === "message.ephemeral" ? { userId } : {},
				text: outputText(turn.output)
			}
		});
		return work.react.effects([reply]);
	});
	app.on(`${integrationId}.message.mentioned`, handleMessage);
	app.on(`${integrationId}.message.received`, handleMessage);
	return app.on(`${integrationId}.command.invoked`, handleCommand);
};
const claudeTag = (options) => defineLoop({
	id: "claude-tag",
	version: "0.1.0",
	description: "Keep Claude present in Slack conversations and commands",
	spec: {
		integration: "slack",
		sources: [
			"slack.message.mentioned",
			"slack.message.received",
			"slack.command.invoked"
		],
		association: {
			scope: "slack.channel-or-dm",
			workThread: "slack.thread-or-dm-conversation"
		},
		agent: {
			id: options.agentId,
			session: "per-work-thread"
		},
		commandVisibility: options.commandVisibility ?? "ephemeral",
		context: options.context === void 0 ? "event" : "extension:context",
		reaction: "terminal-per-event"
	}
}, (app) => installClaudeTagHandlers(app, options));
//#endregion
export { claudeTag, coordinatorLoop, linearAgentSurface, linearLoop, projectLinearAgentSurface };

//# sourceMappingURL=index.js.map
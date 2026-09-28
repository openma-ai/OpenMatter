import { IntegrationError } from "@openmatter/integration";
import { Data, Effect, Schema } from "effect";
//#region src/index.ts
const AttachmentSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	kind: Schema.Literal("image", "file"),
	mimeType: Schema.String,
	data: Schema.String
});
const ProjectCommandBaseSchema = {
	schemaVersion: Schema.String,
	id: Schema.String,
	idempotencyKey: Schema.String,
	scopeId: Schema.String,
	runId: Schema.optional(Schema.String),
	authority: Schema.String,
	occurredAt: Schema.String
};
const ProjectCommandSchema = Schema.Union(Schema.Struct({
	...ProjectCommandBaseSchema,
	type: Schema.Literal("worker.requested"),
	payload: Schema.Struct({
		workerId: Schema.String,
		task: Schema.String,
		attachments: Schema.optional(Schema.Array(AttachmentSchema))
	})
}), Schema.Struct({
	...ProjectCommandBaseSchema,
	type: Schema.Literal("worker.steered"),
	payload: Schema.Struct({
		workerId: Schema.String,
		instruction: Schema.String,
		attachments: Schema.optional(Schema.Array(AttachmentSchema))
	})
}), Schema.Struct({
	...ProjectCommandBaseSchema,
	type: Schema.Literal("worker.cancel.requested"),
	payload: Schema.Struct({
		workerId: Schema.String,
		reason: Schema.optional(Schema.String)
	})
}), Schema.Struct({
	...ProjectCommandBaseSchema,
	type: Schema.Literal("project.completed"),
	payload: Schema.Struct({ summary: Schema.String })
})).annotations({ identifier: "ProjectCommand" });
const PROJECT_WORK_EVENT_TYPES = [
	"project.worker.requested",
	"project.worker.steered",
	"project.worker.cancel.requested",
	"project.completed"
];
var ProjectControlError = class extends Data.TaggedError("ProjectControlError") {};
const nonEmpty = (value, field) => {
	const normalized = value.trim();
	if (normalized.length === 0) throw new ProjectControlError({ message: `${field} must not be empty` });
	return normalized;
};
const makeMemoryProjectCommandSink = () => {
	const accepted = /* @__PURE__ */ new Map();
	const pending = [];
	return {
		publish: (command) => Effect.sync(() => {
			if (accepted.has(command.idempotencyKey)) return "duplicate";
			const snapshot = structuredClone(command);
			accepted.set(command.idempotencyKey, snapshot);
			pending.push(snapshot);
			return "accepted";
		}),
		drain: Effect.sync(() => {
			const commands = structuredClone(pending);
			pending.length = 0;
			return commands;
		})
	};
};
const makeProjectControl = (options) => {
	const scopeId = nonEmpty(options.scopeId, "scopeId");
	const runId = options.runId === void 0 ? void 0 : nonEmpty(options.runId, "runId");
	const authority = nonEmpty(options.authority, "authority");
	const clock = options.clock ?? (() => (/* @__PURE__ */ new Date()).toISOString());
	const makeId = options.makeId ?? (() => globalThis.crypto.randomUUID());
	const publish = (input) => Effect.gen(function* () {
		const id = makeId();
		const idempotencyKey = `project-command:${id}`;
		const command = {
			schemaVersion: "0.1",
			id,
			idempotencyKey,
			type: input.type,
			scopeId,
			...runId === void 0 ? {} : { runId },
			authority,
			occurredAt: clock(),
			payload: input.payload
		};
		return {
			commandId: id,
			idempotencyKey,
			status: yield* options.sink.publish(command)
		};
	});
	return {
		delegate: ({ workerId, task, attachments }) => Effect.try({
			try: () => ({
				type: "worker.requested",
				payload: {
					workerId: nonEmpty(workerId, "workerId"),
					task: nonEmpty(task, "task"),
					...attachments?.length ? { attachments } : {}
				}
			}),
			catch: (cause) => cause instanceof ProjectControlError ? cause : new ProjectControlError({
				message: "Invalid delegate command",
				cause
			})
		}).pipe(Effect.flatMap(publish)),
		steer: ({ workerId, instruction, attachments }) => Effect.try({
			try: () => ({
				type: "worker.steered",
				payload: {
					workerId: nonEmpty(workerId, "workerId"),
					instruction: nonEmpty(instruction, "instruction"),
					...attachments?.length ? { attachments } : {}
				}
			}),
			catch: (cause) => cause instanceof ProjectControlError ? cause : new ProjectControlError({
				message: "Invalid steer command",
				cause
			})
		}).pipe(Effect.flatMap(publish)),
		cancel: ({ workerId, reason }) => Effect.try({
			try: () => ({
				type: "worker.cancel.requested",
				payload: {
					workerId: nonEmpty(workerId, "workerId"),
					...reason === void 0 ? {} : { reason: nonEmpty(reason, "reason") }
				}
			}),
			catch: (cause) => cause instanceof ProjectControlError ? cause : new ProjectControlError({
				message: "Invalid cancel command",
				cause
			})
		}).pipe(Effect.flatMap(publish)),
		complete: ({ summary }) => Effect.try({
			try: () => ({
				type: "project.completed",
				payload: { summary: nonEmpty(summary, "summary") }
			}),
			catch: (cause) => cause instanceof ProjectControlError ? cause : new ProjectControlError({
				message: "Invalid complete command",
				cause
			})
		}).pipe(Effect.flatMap(publish))
	};
};
const workerIdFrom = (command) => command.type === "project.completed" ? void 0 : command.payload.workerId;
const workEventTypeFrom = (command) => command.type === "project.completed" ? "project.completed" : `project.${command.type}`;
const runFieldFrom = (command) => command.runId === void 0 ? {} : { runId: command.runId };
const isJsonObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const commandPayloadFrom = (command) => {
	switch (command.type) {
		case "worker.requested": return {
			workerId: command.payload.workerId,
			task: command.payload.task,
			...command.payload.attachments?.length ? { attachments: [...command.payload.attachments] } : {}
		};
		case "worker.steered": return {
			workerId: command.payload.workerId,
			instruction: command.payload.instruction,
			...command.payload.attachments?.length ? { attachments: [...command.payload.attachments] } : {}
		};
		case "worker.cancel.requested": return {
			workerId: command.payload.workerId,
			...command.payload.reason === void 0 ? {} : { reason: command.payload.reason }
		};
		case "project.completed": return { summary: command.payload.summary };
	}
};
const eventPayloadFrom = (command) => {
	switch (command.type) {
		case "worker.requested": return {
			commandId: command.id,
			...runFieldFrom(command),
			workerId: command.payload.workerId,
			task: command.payload.task,
			...command.payload.attachments?.length ? { attachments: [...command.payload.attachments] } : {}
		};
		case "worker.steered": return {
			commandId: command.id,
			...runFieldFrom(command),
			workerId: command.payload.workerId,
			instruction: command.payload.instruction,
			...command.payload.attachments?.length ? { attachments: [...command.payload.attachments] } : {}
		};
		case "worker.cancel.requested": return {
			commandId: command.id,
			...runFieldFrom(command),
			workerId: command.payload.workerId,
			...command.payload.reason === void 0 ? {} : { reason: command.payload.reason }
		};
		case "project.completed": return {
			commandId: command.id,
			...runFieldFrom(command),
			summary: command.payload.summary
		};
	}
};
const commandJsonFrom = (command) => ({
	schemaVersion: command.schemaVersion,
	id: command.id,
	idempotencyKey: command.idempotencyKey,
	type: command.type,
	scopeId: command.scopeId,
	...command.runId === void 0 ? {} : { runId: command.runId },
	authority: command.authority,
	occurredAt: command.occurredAt,
	payload: commandPayloadFrom(command)
});
/**
* Durable command sink shared by MCP, native-tool, and application bindings.
* The host claims these items and passes `item.body` to the Project
* WorkIntegration; tool execution never runs a nested Agent Turn inline.
*/
const projectCommandSinkFromInbox = (inbox) => ({ publish: (command) => inbox.enqueue({
	id: command.idempotencyKey,
	idempotencyKey: command.idempotencyKey,
	integrationId: "project",
	eventType: workEventTypeFrom(command),
	body: commandJsonFrom(command),
	receivedAt: command.occurredAt
}).pipe(Effect.map((status) => status === "stored" ? "accepted" : "duplicate"), Effect.mapError((cause) => new ProjectControlError({
	message: "Unable to persist Project command",
	cause
}))) });
const makeProjectIntegration = () => ({
	manifest: {
		id: "project",
		displayName: "OpenMatter Project Control",
		events: PROJECT_WORK_EVENT_TYPES,
		operations: []
	},
	ingest: (input) => Schema.decodeUnknown(ProjectCommandSchema)(input).pipe(Effect.mapError((cause) => new IntegrationError({
		message: "Invalid Project command",
		retryable: false,
		cause
	})), Effect.map((command) => {
		const workerId = workerIdFrom(command);
		return [{
			schemaVersion: "0.1",
			id: `project:${command.id}`,
			type: workEventTypeFrom(command),
			occurredAt: command.occurredAt,
			receivedAt: command.occurredAt,
			idempotencyKey: command.idempotencyKey,
			source: {
				provider: "project",
				authority: command.authority,
				conversationId: command.scopeId,
				...workerId === void 0 ? {} : { threadId: workerId },
				messageId: command.id
			},
			payload: eventPayloadFrom(command),
			raw: commandJsonFrom(command)
		}];
	})),
	deliver: () => Effect.fail(new IntegrationError({
		message: "Project Control does not expose outbound WorkEffects",
		retryable: false
	}))
});
const associateProjectEvent = (work) => {
	const { event } = work;
	if (event.source.provider !== "project" || event.source.conversationId === void 0) throw new TypeError("Project association requires a Project WorkEvent");
	const workerId = event.source.threadId;
	const runId = isJsonObject(event.payload) && typeof event.payload.runId === "string" ? event.payload.runId : void 0;
	return {
		scopeId: event.source.conversationId,
		...runId === void 0 ? {} : { runId },
		authority: event.source.authority,
		thread: workerId === void 0 ? { kind: "coordinator" } : {
			kind: "worker",
			id: workerId
		}
	};
};
//#endregion
export { PROJECT_WORK_EVENT_TYPES, ProjectCommandSchema, ProjectControlError, associateProjectEvent, makeMemoryProjectCommandSink, makeProjectControl, makeProjectIntegration, projectCommandSinkFromInbox };

//# sourceMappingURL=index.js.map
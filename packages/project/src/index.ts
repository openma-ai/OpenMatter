import type { JsonValue, WorkEvent } from "@openmatter/core";
import {
  IntegrationError,
  type WorkIntegration,
} from "@openmatter/integration";
import type { DurableInbox } from "@openmatter/inbox";
import type { CoordinatorAssociation } from "@openmatter/orchestration";
import type { WorkContext } from "@openmatter/runtime";
import { Data, Effect, Schema } from "effect";

const AttachmentSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literal("image", "file"),
  mimeType: Schema.String,
  data: Schema.String,
});
type Attachment = typeof AttachmentSchema.Type;
const ProjectCommandBaseSchema = {
  schemaVersion: Schema.String,
  id: Schema.String,
  idempotencyKey: Schema.String,
  scopeId: Schema.String,
  runId: Schema.optional(Schema.String),
  authority: Schema.String,
  occurredAt: Schema.String,
};

export const ProjectCommandSchema = Schema.Union(
  Schema.Struct({
    ...ProjectCommandBaseSchema,
    type: Schema.Literal("worker.requested"),
    payload: Schema.Struct({
      workerId: Schema.String,
      task: Schema.String,
      attachments: Schema.optional(Schema.Array(AttachmentSchema)),
    }),
  }),
  Schema.Struct({
    ...ProjectCommandBaseSchema,
    type: Schema.Literal("worker.steered"),
    payload: Schema.Struct({
      workerId: Schema.String,
      instruction: Schema.String,
      attachments: Schema.optional(Schema.Array(AttachmentSchema)),
    }),
  }),
  Schema.Struct({
    ...ProjectCommandBaseSchema,
    type: Schema.Literal("worker.cancel.requested"),
    payload: Schema.Struct({
      workerId: Schema.String,
      reason: Schema.optional(Schema.String),
    }),
  }),
  Schema.Struct({
    ...ProjectCommandBaseSchema,
    type: Schema.Literal("project.completed"),
    payload: Schema.Struct({ summary: Schema.String }),
  }),
).annotations({ identifier: "ProjectCommand" });

export type ProjectCommand = typeof ProjectCommandSchema.Type;
export type ProjectCommandType = ProjectCommand["type"];

export const PROJECT_WORK_EVENT_TYPES = [
  "project.worker.requested",
  "project.worker.steered",
  "project.worker.cancel.requested",
  "project.completed",
] as const;

export class ProjectControlError extends Data.TaggedError(
  "ProjectControlError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ProjectCommandSink {
  readonly publish: (
    command: ProjectCommand,
  ) => Effect.Effect<"accepted" | "duplicate", ProjectControlError>;
}

export interface ProjectCommandReceipt {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly status: "accepted" | "duplicate";
}

export interface ProjectControl {
  readonly delegate: (input: {
    readonly workerId: string;
    readonly task: string;
    readonly attachments?: readonly Attachment[];
  }) => Effect.Effect<ProjectCommandReceipt, ProjectControlError>;
  readonly steer: (input: {
    readonly workerId: string;
    readonly instruction: string;
    readonly attachments?: readonly Attachment[];
  }) => Effect.Effect<ProjectCommandReceipt, ProjectControlError>;
  readonly cancel: (input: {
    readonly workerId: string;
    readonly reason?: string;
  }) => Effect.Effect<ProjectCommandReceipt, ProjectControlError>;
  readonly complete: (input: {
    readonly summary: string;
  }) => Effect.Effect<ProjectCommandReceipt, ProjectControlError>;
}

export interface MemoryProjectCommandSink extends ProjectCommandSink {
  readonly drain: Effect.Effect<readonly ProjectCommand[]>;
}

const nonEmpty = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ProjectControlError({ message: `${field} must not be empty` });
  }
  return normalized;
};

export const makeMemoryProjectCommandSink = (): MemoryProjectCommandSink => {
  const accepted = new Map<string, ProjectCommand>();
  const pending: ProjectCommand[] = [];

  return {
    publish: (command) =>
      Effect.sync(() => {
        if (accepted.has(command.idempotencyKey)) return "duplicate" as const;
        const snapshot = structuredClone(command);
        accepted.set(command.idempotencyKey, snapshot);
        pending.push(snapshot);
        return "accepted" as const;
      }),
    drain: Effect.sync(() => {
      const commands = structuredClone(pending);
      pending.length = 0;
      return commands;
    }),
  };
};

export const makeProjectControl = (options: {
  readonly scopeId: string;
  readonly runId?: string;
  readonly authority: string;
  readonly sink: ProjectCommandSink;
  readonly clock?: () => string;
  readonly makeId?: () => string;
}): ProjectControl => {
  const scopeId = nonEmpty(options.scopeId, "scopeId");
  const runId =
    options.runId === undefined ? undefined : nonEmpty(options.runId, "runId");
  const authority = nonEmpty(options.authority, "authority");
  const clock = options.clock ?? (() => new Date().toISOString());
  const makeId = options.makeId ?? (() => globalThis.crypto.randomUUID());

  const publish = (
    input:
      | {
          readonly type: "worker.requested";
          readonly payload: {
            readonly workerId: string;
            readonly task: string;
            readonly attachments?: readonly Attachment[];
          };
        }
      | {
          readonly type: "worker.steered";
          readonly payload: {
            readonly workerId: string;
            readonly instruction: string;
            readonly attachments?: readonly Attachment[];
          };
        }
      | {
          readonly type: "worker.cancel.requested";
          readonly payload: {
            readonly workerId: string;
            readonly reason?: string;
          };
        }
      | {
          readonly type: "project.completed";
          readonly payload: { readonly summary: string };
        },
  ) =>
    Effect.gen(function* () {
      const id = makeId();
      const idempotencyKey = `project-command:${id}`;
      const command = {
        schemaVersion: "0.1",
        id,
        idempotencyKey,
        type: input.type,
        scopeId,
        ...(runId === undefined ? {} : { runId }),
        authority,
        occurredAt: clock(),
        payload: input.payload,
      } as ProjectCommand;
      const status = yield* options.sink.publish(command);
      return { commandId: id, idempotencyKey, status };
    });

  return {
    delegate: ({ workerId, task, attachments }) =>
      Effect.try({
        try: () => ({
          type: "worker.requested" as const,
          payload: {
            workerId: nonEmpty(workerId, "workerId"),
            task: nonEmpty(task, "task"),
            ...(attachments?.length ? { attachments } : {}),
          },
        }),
        catch: (cause) =>
          cause instanceof ProjectControlError
            ? cause
            : new ProjectControlError({
                message: "Invalid delegate command",
                cause,
              }),
      }).pipe(Effect.flatMap(publish)),
    steer: ({ workerId, instruction, attachments }) =>
      Effect.try({
        try: () => ({
          type: "worker.steered" as const,
          payload: {
            workerId: nonEmpty(workerId, "workerId"),
            instruction: nonEmpty(instruction, "instruction"),
            ...(attachments?.length ? { attachments } : {}),
          },
        }),
        catch: (cause) =>
          cause instanceof ProjectControlError
            ? cause
            : new ProjectControlError({
                message: "Invalid steer command",
                cause,
              }),
      }).pipe(Effect.flatMap(publish)),
    cancel: ({ workerId, reason }) =>
      Effect.try({
        try: () => ({
          type: "worker.cancel.requested" as const,
          payload: {
            workerId: nonEmpty(workerId, "workerId"),
            ...(reason === undefined
              ? {}
              : { reason: nonEmpty(reason, "reason") }),
          },
        }),
        catch: (cause) =>
          cause instanceof ProjectControlError
            ? cause
            : new ProjectControlError({
                message: "Invalid cancel command",
                cause,
              }),
      }).pipe(Effect.flatMap(publish)),
    complete: ({ summary }) =>
      Effect.try({
        try: () => ({
          type: "project.completed" as const,
          payload: { summary: nonEmpty(summary, "summary") },
        }),
        catch: (cause) =>
          cause instanceof ProjectControlError
            ? cause
            : new ProjectControlError({
                message: "Invalid complete command",
                cause,
              }),
      }).pipe(Effect.flatMap(publish)),
  };
};

const workerIdFrom = (command: ProjectCommand): string | undefined =>
  command.type === "project.completed" ? undefined : command.payload.workerId;

const workEventTypeFrom = (command: ProjectCommand): string =>
  command.type === "project.completed"
    ? "project.completed"
    : `project.${command.type}`;

const runFieldFrom = (
  command: ProjectCommand,
): {} | { readonly runId: string } =>
  command.runId === undefined ? {} : { runId: command.runId };

const isJsonObject = (
  value: unknown,
): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const commandPayloadFrom = (command: ProjectCommand): JsonValue => {
  switch (command.type) {
    case "worker.requested":
      return {
        workerId: command.payload.workerId,
        task: command.payload.task,
        ...(command.payload.attachments?.length
          ? { attachments: [...command.payload.attachments] }
          : {}),
      };
    case "worker.steered":
      return {
        workerId: command.payload.workerId,
        instruction: command.payload.instruction,
        ...(command.payload.attachments?.length
          ? { attachments: [...command.payload.attachments] }
          : {}),
      };
    case "worker.cancel.requested":
      return {
        workerId: command.payload.workerId,
        ...(command.payload.reason === undefined
          ? {}
          : { reason: command.payload.reason }),
      };
    case "project.completed":
      return { summary: command.payload.summary };
  }
};

const eventPayloadFrom = (command: ProjectCommand): JsonValue => {
  switch (command.type) {
    case "worker.requested":
      return {
        commandId: command.id,
        ...runFieldFrom(command),
        workerId: command.payload.workerId,
        task: command.payload.task,
        ...(command.payload.attachments?.length
          ? { attachments: [...command.payload.attachments] }
          : {}),
      };
    case "worker.steered":
      return {
        commandId: command.id,
        ...runFieldFrom(command),
        workerId: command.payload.workerId,
        instruction: command.payload.instruction,
        ...(command.payload.attachments?.length
          ? { attachments: [...command.payload.attachments] }
          : {}),
      };
    case "worker.cancel.requested":
      return {
        commandId: command.id,
        ...runFieldFrom(command),
        workerId: command.payload.workerId,
        ...(command.payload.reason === undefined
          ? {}
          : { reason: command.payload.reason }),
      };
    case "project.completed":
      return {
        commandId: command.id,
        ...runFieldFrom(command),
        summary: command.payload.summary,
      };
  }
};

const commandJsonFrom = (command: ProjectCommand): JsonValue => ({
  schemaVersion: command.schemaVersion,
  id: command.id,
  idempotencyKey: command.idempotencyKey,
  type: command.type,
  scopeId: command.scopeId,
  ...(command.runId === undefined ? {} : { runId: command.runId }),
  authority: command.authority,
  occurredAt: command.occurredAt,
  payload: commandPayloadFrom(command),
});

/**
 * Durable command sink shared by MCP, native-tool, and application bindings.
 * The host claims these items and passes `item.body` to the Project
 * WorkIntegration; tool execution never runs a nested Agent Turn inline.
 */
export const projectCommandSinkFromInbox = (
  inbox: DurableInbox,
): ProjectCommandSink => ({
  publish: (command) =>
    inbox
      .enqueue({
        id: command.idempotencyKey,
        idempotencyKey: command.idempotencyKey,
        integrationId: "project",
        eventType: workEventTypeFrom(command),
        body: commandJsonFrom(command),
        receivedAt: command.occurredAt,
      })
      .pipe(
        Effect.map((status) =>
          status === "stored" ? ("accepted" as const) : ("duplicate" as const),
        ),
        Effect.mapError(
          (cause) =>
            new ProjectControlError({
              message: "Unable to persist Project command",
              cause,
            }),
        ),
      ),
});

export const makeProjectIntegration = (): WorkIntegration => ({
  manifest: {
    id: "project",
    displayName: "OpenMatter Project Control",
    events: PROJECT_WORK_EVENT_TYPES,
    operations: [],
  },
  ingest: (input) =>
    Schema.decodeUnknown(ProjectCommandSchema)(input).pipe(
      Effect.mapError(
        (cause) =>
          new IntegrationError({
            message: "Invalid Project command",
            retryable: false,
            cause,
          }),
      ),
      Effect.map((command) => {
        const workerId = workerIdFrom(command);
        const event: WorkEvent = {
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
            ...(workerId === undefined ? {} : { threadId: workerId }),
            messageId: command.id,
          },
          payload: eventPayloadFrom(command),
          raw: commandJsonFrom(command),
        };
        return [event];
      }),
    ),
  deliver: () =>
    Effect.fail(
      new IntegrationError({
        message: "Project Control does not expose outbound WorkEffects",
        retryable: false,
      }),
    ),
});

export const associateProjectEvent = (
  work: Pick<WorkContext, "event">,
): CoordinatorAssociation => {
  const { event } = work;
  if (
    event.source.provider !== "project" ||
    event.source.conversationId === undefined
  ) {
    throw new TypeError("Project association requires a Project WorkEvent");
  }
  const workerId = event.source.threadId;
  const runId =
    isJsonObject(event.payload) && typeof event.payload.runId === "string"
      ? event.payload.runId
      : undefined;
  return {
    scopeId: event.source.conversationId,
    ...(runId === undefined ? {} : { runId }),
    authority: event.source.authority,
    thread:
      workerId === undefined
        ? { kind: "coordinator" }
        : { kind: "worker", id: workerId },
  };
};

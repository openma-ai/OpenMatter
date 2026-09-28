import { WorkIntegration } from "@openmatter/integration";
import { Effect, Schema } from "effect";
import { DurableInbox } from "@openmatter/inbox";
import { CoordinatorAssociation } from "@openmatter/orchestration";
import { WorkContext } from "@openmatter/runtime";
//#region src/index.d.ts
declare const AttachmentSchema: Schema.Struct<{
  id: typeof Schema.String;
  name: typeof Schema.String;
  kind: Schema.Literal<["image", "file"]>;
  mimeType: typeof Schema.String;
  data: typeof Schema.String;
}>;
type Attachment = typeof AttachmentSchema.Type;
declare const ProjectCommandSchema: Schema.Union<[Schema.Struct<{
  type: Schema.Literal<["worker.requested"]>;
  payload: Schema.Struct<{
    workerId: typeof Schema.String;
    task: typeof Schema.String;
    attachments: Schema.optional<Schema.Array$<Schema.Struct<{
      id: typeof Schema.String;
      name: typeof Schema.String;
      kind: Schema.Literal<["image", "file"]>;
      mimeType: typeof Schema.String;
      data: typeof Schema.String;
    }>>>;
  }>;
  schemaVersion: typeof Schema.String;
  id: typeof Schema.String;
  idempotencyKey: typeof Schema.String;
  scopeId: typeof Schema.String;
  runId: Schema.optional<typeof Schema.String>;
  authority: typeof Schema.String;
  occurredAt: typeof Schema.String;
}>, Schema.Struct<{
  type: Schema.Literal<["worker.steered"]>;
  payload: Schema.Struct<{
    workerId: typeof Schema.String;
    instruction: typeof Schema.String;
    attachments: Schema.optional<Schema.Array$<Schema.Struct<{
      id: typeof Schema.String;
      name: typeof Schema.String;
      kind: Schema.Literal<["image", "file"]>;
      mimeType: typeof Schema.String;
      data: typeof Schema.String;
    }>>>;
  }>;
  schemaVersion: typeof Schema.String;
  id: typeof Schema.String;
  idempotencyKey: typeof Schema.String;
  scopeId: typeof Schema.String;
  runId: Schema.optional<typeof Schema.String>;
  authority: typeof Schema.String;
  occurredAt: typeof Schema.String;
}>, Schema.Struct<{
  type: Schema.Literal<["worker.cancel.requested"]>;
  payload: Schema.Struct<{
    workerId: typeof Schema.String;
    reason: Schema.optional<typeof Schema.String>;
  }>;
  schemaVersion: typeof Schema.String;
  id: typeof Schema.String;
  idempotencyKey: typeof Schema.String;
  scopeId: typeof Schema.String;
  runId: Schema.optional<typeof Schema.String>;
  authority: typeof Schema.String;
  occurredAt: typeof Schema.String;
}>, Schema.Struct<{
  type: Schema.Literal<["project.completed"]>;
  payload: Schema.Struct<{
    summary: typeof Schema.String;
  }>;
  schemaVersion: typeof Schema.String;
  id: typeof Schema.String;
  idempotencyKey: typeof Schema.String;
  scopeId: typeof Schema.String;
  runId: Schema.optional<typeof Schema.String>;
  authority: typeof Schema.String;
  occurredAt: typeof Schema.String;
}>]>;
type ProjectCommand = typeof ProjectCommandSchema.Type;
type ProjectCommandType = ProjectCommand["type"];
declare const PROJECT_WORK_EVENT_TYPES: readonly ["project.worker.requested", "project.worker.steered", "project.worker.cancel.requested", "project.completed"];
declare const ProjectControlError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
  readonly _tag: "ProjectControlError";
} & Readonly<A>;
declare class ProjectControlError extends ProjectControlError_base<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
interface ProjectCommandSink {
  readonly publish: (command: ProjectCommand) => Effect.Effect<"accepted" | "duplicate", ProjectControlError>;
}
interface ProjectCommandReceipt {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly status: "accepted" | "duplicate";
}
interface ProjectControl {
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
interface MemoryProjectCommandSink extends ProjectCommandSink {
  readonly drain: Effect.Effect<readonly ProjectCommand[]>;
}
declare const makeMemoryProjectCommandSink: () => MemoryProjectCommandSink;
declare const makeProjectControl: (options: {
  readonly scopeId: string;
  readonly runId?: string;
  readonly authority: string;
  readonly sink: ProjectCommandSink;
  readonly clock?: () => string;
  readonly makeId?: () => string;
}) => ProjectControl;
/**
 * Durable command sink shared by MCP, native-tool, and application bindings.
 * The host claims these items and passes `item.body` to the Project
 * WorkIntegration; tool execution never runs a nested Agent Turn inline.
 */
declare const projectCommandSinkFromInbox: (inbox: DurableInbox) => ProjectCommandSink;
declare const makeProjectIntegration: () => WorkIntegration;
declare const associateProjectEvent: (work: Pick<WorkContext, "event">) => CoordinatorAssociation;
//#endregion
export { MemoryProjectCommandSink, PROJECT_WORK_EVENT_TYPES, ProjectCommand, ProjectCommandReceipt, ProjectCommandSchema, ProjectCommandSink, ProjectCommandType, ProjectControl, ProjectControlError, associateProjectEvent, makeMemoryProjectCommandSink, makeProjectControl, makeProjectIntegration, projectCommandSinkFromInbox };
//# sourceMappingURL=index.d.ts.map
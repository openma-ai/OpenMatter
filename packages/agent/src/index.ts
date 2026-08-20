import {
  JsonValueSchema,
  type ContextProjection,
  type JsonValue,
} from "@openmatter/core";
import { Context, Data, Layer, Schema, type Effect, type Stream } from "effect";

export const AgentSessionHandleSchema = Schema.Struct({
  id: Schema.String,
  raw: Schema.optional(JsonValueSchema),
}).annotations({ identifier: "AgentSessionHandle" });

export type AgentSessionHandle = typeof AgentSessionHandleSchema.Type;

export interface AgentSessionCreateInput {
  readonly sessionId: string;
  readonly bindingKey: string;
  readonly generation: number;
  /** Stable across replay; Drivers must make remote creation idempotent by it. */
  readonly idempotencyKey: string;
}

export const OpenMAEventSchema = Schema.Struct({
  schemaVersion: Schema.String,
  id: Schema.String,
  sessionId: Schema.String,
  turnId: Schema.String,
  sequence: Schema.Number,
  type: Schema.String,
  timestamp: Schema.String,
  payload: JsonValueSchema,
  raw: Schema.optional(JsonValueSchema),
}).annotations({ identifier: "OpenMAEvent" });

export type OpenMAEvent = typeof OpenMAEventSchema.Type;

export interface AgentTurnInput {
  readonly session: AgentSessionHandle;
  readonly sessionId: string;
  readonly turnId: string;
  /** Last durably observed sequence for replay/resume. */
  readonly afterSequence: number;
  readonly context: ContextProjection;
  readonly allow: readonly string[];
}

export class AgentDriverError extends Data.TaggedError("AgentDriverError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class AgentSessionUnavailableError extends Data.TaggedError(
  "AgentSessionUnavailableError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface AgentDriver {
  readonly id: string;
  readonly capabilities: () => Effect.Effect<
    AgentCapabilities,
    AgentDriverError
  >;
  readonly createSession: (
    input: AgentSessionCreateInput,
  ) => Effect.Effect<AgentSessionHandle, AgentDriverError>;
  readonly resumeSession: (
    handle: AgentSessionHandle,
  ) => Effect.Effect<
    AgentSessionHandle,
    AgentDriverError | AgentSessionUnavailableError
  >;
  readonly turn: (
    input: AgentTurnInput,
  ) => Stream.Stream<OpenMAEvent, AgentDriverError>;
  /** Repeated responses for one Session/request id must be idempotent. */
  readonly respondToPermission: (input: {
    readonly session: AgentSessionHandle;
    readonly requestId: string;
    readonly approved: boolean;
  }) => Effect.Effect<void, AgentDriverError>;
  /** Repeated cancellation for one Session/Turn must be idempotent. */
  readonly cancel: (input: {
    readonly session: AgentSessionHandle;
    readonly turnId: string;
  }) => Effect.Effect<void, AgentDriverError>;
  /** Repeated close for one Session must be idempotent; an already-closed or
   * provider-missing Session is success, not a permanent recovery failure. */
  readonly closeSession: (
    session: AgentSessionHandle,
  ) => Effect.Effect<void, AgentDriverError>;
}

export interface AgentCapabilities {
  readonly resume: boolean;
  readonly cancel: boolean;
  readonly permissions: boolean;
  readonly concurrentTurns: boolean;
}

export type AgentDriverRegistry = ReadonlyMap<string, AgentDriver>;

export const AgentDrivers = Context.GenericTag<AgentDriverRegistry>(
  "@openmatter/agent/AgentDrivers",
);

export const agentDriverLayer = (
  drivers: Readonly<Record<string, AgentDriver>>,
) => Layer.succeed(AgentDrivers, new Map(Object.entries(drivers)));

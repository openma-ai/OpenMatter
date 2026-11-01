import {
  JsonValueSchema,
  type ContextProjection,
  type JsonValue,
} from "../index.js";
import {
  isOpenMAEvent as isCanonicalOpenMAEvent,
  type OpenMAEvent as CanonicalOpenMAEvent,
} from "@openma/common/agent-contract";
import { Context, Data, Layer, Schema, type Effect, type Stream } from "effect";

export {
  createOpenMAEvent,
  immutableJson,
  isCallbackRequestEvent,
  isElicitationRequestEvent,
  isOpenMAEvent,
  isPermissionRequestEvent,
  isTurnTerminalEvent,
  OPENMA_CANONICAL_EVENT_TYPES,
  OPENMA_EVENT_SCHEMA_VERSION,
  OPENMA_EVENT_TYPES,
  turnTerminalStatus,
} from "@openma/common/agent-contract";
export type { OpenMAEventSource } from "@openma/common/agent-contract";

export const AgentSessionHandleSchema = Schema.Struct({
  id: Schema.String,
  raw: Schema.optional(JsonValueSchema),
}).annotations({ identifier: "AgentSessionHandle" });

export type AgentSessionHandle = typeof AgentSessionHandleSchema.Type;

export interface AgentSessionCreateInput {
  readonly sessionId: string;
  readonly bindingKey: string;
  /** Stable work identity, independent of the session generation. */
  readonly scopeId?: string;
  readonly workThreadId?: string;
  readonly generation: number;
  /** Stable across replay; Drivers must make remote creation idempotent by it. */
  readonly idempotencyKey: string;
}

/** Effect-facing view of the validator owned by openma-common. */
export const OpenMAEventSchema = Schema.declare<CanonicalOpenMAEvent>(
  isCanonicalOpenMAEvent,
  {
    identifier: "OpenMAEvent",
    description: "Immutable OpenMA Agent event validated by openma-common",
  },
);

/** The single canonical Agent event vocabulary lives in openma-common. */
export type OpenMAEvent = CanonicalOpenMAEvent;

/**
 * The callback method a driver reports when its Agent calls an operation the
 * Turn allows. The request is a `callback.requested` event with category
 * `extension`, this method, and `params` of `OperationCallParams`; the runtime
 * answers through `respondToCallback` with an `OperationCallResult`.
 */
export const OPERATION_CALL_METHOD = "openmatter/operation";

export interface OperationCallParams {
  readonly integrationId: string;
  readonly operation: string;
  readonly input: JsonValue;
}

/** One operation the Turn allows, described for the Agent as a tool. */
export interface AgentTool {
  /** `${integrationId}.${operation}`, as in `allow`. */
  readonly name: string;
  readonly integrationId: string;
  readonly operation: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
}

export interface AgentTurnInput {
  readonly session: AgentSessionHandle;
  readonly sessionId: string;
  readonly turnId: string;
  /** Last durably observed sequence for replay/resume. */
  readonly afterSequence: number;
  readonly context: ContextProjection;
  readonly allow: readonly string[];
  /** Allowed operations whose integration describes them as tools. A driver
   * whose capabilities include `operations` exposes these to the Agent. */
  readonly tools?: readonly AgentTool[];
}

/** One instruction injected into a running Turn. */
export interface AgentSteerInput {
  readonly session: AgentSessionHandle;
  readonly sessionId: string;
  /** The running Turn the instruction targets. */
  readonly turnId: string;
  /** Stable per logical steer (the WorkEvent idempotency key). Repeated
   * delivery of one steerId MUST be applied at most once. */
  readonly steerId: string;
  readonly context: ContextProjection;
}

/**
 * The driver's answer to a live steer. `accepted` promises the instruction
 * reaches the Agent inside `turnId` (before its terminal event). Anything the
 * driver cannot promise, such as a Turn that already finished, is `rejected`,
 * and the runtime falls back to a new Turn.
 */
export type AgentSteerAck =
  | { readonly status: "accepted" }
  | { readonly status: "rejected"; readonly reason: string };

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
  /** Answers a `callback.requested` the runtime handled, such as an operation
   * call. Repeated responses for one Session/callback id must be idempotent.
   * Required when capabilities include `operations`. */
  readonly respondToCallback?: (input: {
    readonly session: AgentSessionHandle;
    readonly callbackId: string;
    readonly result: JsonValue;
  }) => Effect.Effect<void, AgentDriverError>;
  /** Injects an instruction into the running Turn. Required when
   * capabilities include `steering`. Repeated calls for one steerId must be
   * idempotent. */
  readonly steer?: (
    input: AgentSteerInput,
  ) => Effect.Effect<AgentSteerAck, AgentDriverError>;
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
  /** The driver exposes `AgentTurnInput.tools` to the Agent and reports calls
   * as `OPERATION_CALL_METHOD` callbacks. */
  readonly operations?: boolean;
  /** The driver implements `steer`: an instruction can reach a running Turn
   * instead of waiting for the next one. */
  readonly steering?: boolean;
}

export type AgentDriverRegistry = ReadonlyMap<string, AgentDriver>;

export const AgentDrivers = Context.GenericTag<AgentDriverRegistry>(
  "@openma/matter/agent/AgentDrivers",
);

export const agentDriverLayer = (
  drivers: Readonly<Record<string, AgentDriver>>,
) => Layer.succeed(AgentDrivers, new Map(Object.entries(drivers)));

export * from "./connector.js";

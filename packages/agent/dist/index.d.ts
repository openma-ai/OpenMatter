import { ContextProjection, JsonValue } from "@openmatter/core";
import { OPENMA_CANONICAL_EVENT_TYPES, OPENMA_EVENT_SCHEMA_VERSION, OPENMA_EVENT_TYPES, OpenMAEvent as OpenMAEvent$1, OpenMAEventSource, createOpenMAEvent, immutableJson, isCallbackRequestEvent, isElicitationRequestEvent, isOpenMAEvent, isPermissionRequestEvent, isTurnTerminalEvent, turnTerminalStatus } from "@openma/common/agent-contract";
import { Context, Effect, Layer, Schema, Stream } from "effect";
//#region src/index.d.ts
declare const AgentSessionHandleSchema: Schema.Struct<{
  id: typeof Schema.String;
  raw: Schema.optional<Schema.declare<JsonValue, JsonValue, readonly [], never>>;
}>;
type AgentSessionHandle = typeof AgentSessionHandleSchema.Type;
interface AgentSessionCreateInput {
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
declare const OpenMAEventSchema: Schema.declare<OpenMAEvent$1, OpenMAEvent$1, readonly [], never>;
/** The single canonical Agent event vocabulary lives in openma-common. */
type OpenMAEvent = OpenMAEvent$1;
interface AgentTurnInput {
  readonly session: AgentSessionHandle;
  readonly sessionId: string;
  readonly turnId: string;
  /** Last durably observed sequence for replay/resume. */
  readonly afterSequence: number;
  readonly context: ContextProjection;
  readonly allow: readonly string[];
}
declare const AgentDriverError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
  readonly _tag: "AgentDriverError";
} & Readonly<A>;
declare class AgentDriverError extends AgentDriverError_base<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
declare const AgentSessionUnavailableError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
  readonly _tag: "AgentSessionUnavailableError";
} & Readonly<A>;
declare class AgentSessionUnavailableError extends AgentSessionUnavailableError_base<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
interface AgentDriver {
  readonly id: string;
  readonly capabilities: () => Effect.Effect<AgentCapabilities, AgentDriverError>;
  readonly createSession: (input: AgentSessionCreateInput) => Effect.Effect<AgentSessionHandle, AgentDriverError>;
  readonly resumeSession: (handle: AgentSessionHandle) => Effect.Effect<AgentSessionHandle, AgentDriverError | AgentSessionUnavailableError>;
  readonly turn: (input: AgentTurnInput) => Stream.Stream<OpenMAEvent, AgentDriverError>;
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
  readonly closeSession: (session: AgentSessionHandle) => Effect.Effect<void, AgentDriverError>;
}
interface AgentCapabilities {
  readonly resume: boolean;
  readonly cancel: boolean;
  readonly permissions: boolean;
  readonly concurrentTurns: boolean;
}
type AgentDriverRegistry = ReadonlyMap<string, AgentDriver>;
declare const AgentDrivers: Context.Tag<AgentDriverRegistry, AgentDriverRegistry>;
declare const agentDriverLayer: (drivers: Readonly<Record<string, AgentDriver>>) => Layer.Layer<AgentDriverRegistry, never, never>;
//#endregion
export { AgentCapabilities, AgentDriver, AgentDriverError, AgentDriverRegistry, AgentDrivers, AgentSessionCreateInput, AgentSessionHandle, AgentSessionHandleSchema, AgentSessionUnavailableError, AgentTurnInput, OPENMA_CANONICAL_EVENT_TYPES, OPENMA_EVENT_SCHEMA_VERSION, OPENMA_EVENT_TYPES, OpenMAEvent, OpenMAEventSchema, type OpenMAEventSource, agentDriverLayer, createOpenMAEvent, immutableJson, isCallbackRequestEvent, isElicitationRequestEvent, isOpenMAEvent, isPermissionRequestEvent, isTurnTerminalEvent, turnTerminalStatus };
//# sourceMappingURL=index.d.ts.map
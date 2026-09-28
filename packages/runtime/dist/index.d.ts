import { AgentDriver, AgentDriverError, OpenMAEvent } from "@openmatter/agent";
import { AgentSession, ContextItem, ContextProjection, EffectDeliveryReceipt, JsonValue, ReactionReceipt, Turn, WorkEffect, WorkEvent } from "@openmatter/core";
import { IntegrationError, WorkIntegration } from "@openmatter/integration";
import { OpenMatterStore, StoreError } from "@openmatter/store";
import { Effect } from "effect";
//#region src/contracts.d.ts
declare const EventBusyError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
  readonly _tag: "EventBusyError";
} & Readonly<A>;
declare class EventBusyError extends EventBusyError_base<{
  readonly eventId: string;
  readonly retryAt: string;
  readonly message: string;
}> {}
declare const AgentAccessError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
  readonly _tag: "AgentAccessError";
} & Readonly<A>;
declare class AgentAccessError extends AgentAccessError_base<{
  readonly agentId: string;
  readonly message: string;
}> {}
declare const ContextProjectionError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
  readonly _tag: "ContextProjectionError";
} & Readonly<A>;
declare class ContextProjectionError extends ContextProjectionError_base<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
declare const SessionBusyError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
  readonly _tag: "SessionBusyError";
} & Readonly<A>;
declare class SessionBusyError extends SessionBusyError_base<{
  readonly bindingKey: string;
  readonly retryAt: string;
  readonly message: string;
}> {}
declare const AuthorizationError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
  readonly _tag: "AuthorizationError";
} & Readonly<A>;
declare class AuthorizationError extends AuthorizationError_base<{
  readonly operation: string;
  readonly message: string;
}> {}
declare const WorkEventValidationError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
  readonly _tag: "WorkEventValidationError";
} & Readonly<A>;
declare class WorkEventValidationError extends WorkEventValidationError_base<{
  readonly eventId?: string;
  readonly message: string;
}> {}
interface EffectInput {
  readonly integrationId: string;
  readonly operation: string;
  readonly input: JsonValue;
  readonly idempotencyKey?: string;
}
interface ReactionDraft {
  readonly status: "completed" | "failed" | "cancelled";
  readonly effects: readonly WorkEffect[];
  readonly reason?: string;
}
interface AgentTurnOptions {
  readonly context: ContextProjection;
  readonly allow?: readonly string[];
}
interface AgentTurnResult {
  readonly session: AgentSession;
  readonly turn: Turn;
  readonly outcome: "completed" | "failed" | "cancelled" | "interrupted";
  readonly events: readonly OpenMAEvent[];
  readonly output: JsonValue | undefined;
}
interface AgentCancellationResult {
  readonly status: "requested" | "idle";
  readonly turnId?: string;
}
interface AgentPermissionRequest {
  readonly agentId: string;
  readonly requestId: string;
  readonly event: OpenMAEvent;
  readonly context: ContextProjection;
}
type AgentPermissionPolicy = (request: AgentPermissionRequest) => boolean | Promise<boolean> | Effect.Effect<boolean, unknown>;
interface WorkContext {
  readonly event: WorkEvent;
  readonly context: {
    readonly event: () => ContextItem;
    readonly value: (input: {
      readonly id?: string;
      readonly kind: string;
      readonly value: JsonValue;
      readonly provenance: ContextItem["provenance"];
    }) => ContextItem;
    readonly project: (input: {
      readonly scopeId: string;
      readonly workThreadId: string;
      readonly items: readonly ContextItem[];
      readonly grants?: readonly string[];
    }) => Effect.Effect<ContextProjection, ContextProjectionError | StoreError>;
  };
  readonly effect: (context: ContextProjection, input: EffectInput) => Effect.Effect<WorkEffect, AuthorizationError | StoreError>;
  readonly react: {
    readonly none: (reason?: string) => ReactionDraft;
    readonly effects: (effects: readonly WorkEffect[], reason?: string) => ReactionDraft;
  };
  readonly agent: (agentId: string) => {
    readonly session: (binding: {
      readonly scopeId: string;
      readonly workThreadId: string;
      readonly authority?: string;
      readonly privacyPartition: string;
    }) => {
      readonly cancel: () => Effect.Effect<AgentCancellationResult, AgentAccessError | AgentDriverError | StoreError>;
      readonly turn: (input: AgentTurnOptions) => Effect.Effect<AgentTurnResult, AgentAccessError | AgentDriverError | AuthorizationError | ContextProjectionError | SessionBusyError | StoreError>;
    };
  };
}
type WorkHandlerResult = ReactionDraft | Promise<ReactionDraft> | Effect.Effect<ReactionDraft, unknown>;
type WorkHandler = (work: WorkContext) => WorkHandlerResult;
interface LoopDefinition {
  readonly id: string;
  readonly version?: string;
  readonly description?: string;
  readonly spec?: JsonValue;
}
interface Loop {
  readonly definition: LoopDefinition;
  readonly install: (app: OpenMatterApplication) => void | OpenMatterApplication;
}
declare const defineLoop: (definition: LoopDefinition, install: Loop["install"]) => Loop;
interface OpenMatterOptions {
  readonly store: OpenMatterStore;
  readonly integrations: Readonly<Record<string, WorkIntegration>>;
  readonly agents: Readonly<Record<string, AgentDriver>>;
  readonly clock?: () => string;
  readonly makeId?: () => string;
  readonly effectConcurrency?: number | "unbounded";
  readonly runtimeId?: string;
  readonly eventLeaseMs?: number;
  readonly effectLeaseMs?: number;
  readonly effectRetryDelayMs?: number;
  readonly sessionLeaseMs?: number;
  readonly permissionPolicy?: AgentPermissionPolicy;
}
interface OpenMatterApplication {
  readonly loop: (loop: Loop) => OpenMatterApplication;
  readonly on: (eventType: string | readonly string[], handler: WorkHandler) => OpenMatterApplication;
  readonly acceptEffect: (event: WorkEvent) => Effect.Effect<ReactionReceipt, EventBusyError | AgentDriverError | SessionBusyError | StoreError | WorkEventValidationError>;
  readonly accept: (event: WorkEvent) => Promise<ReactionReceipt>;
  readonly recoverEffectsEffect: (options?: {
    readonly limit?: number;
  }) => Effect.Effect<readonly EffectDeliveryReceipt[], StoreError>;
  readonly recoverEffects: (options?: {
    readonly limit?: number;
  }) => Promise<readonly EffectDeliveryReceipt[]>;
  readonly acceptFromEffect: (integrationId: string, input: unknown) => Effect.Effect<readonly ReactionReceipt[], EventBusyError | AgentDriverError | IntegrationError | SessionBusyError | StoreError | WorkEventValidationError>;
  readonly acceptFrom: (integrationId: string, input: unknown) => Promise<readonly ReactionReceipt[]>;
  readonly consume: (events: AsyncIterable<WorkEvent>, options?: {
    readonly concurrency?: number;
  }) => Promise<ConsumeSummary>;
}
interface ConsumeSummary {
  readonly processed: number;
  readonly failed: number;
  readonly duplicates: number;
}
type RuntimeInfrastructureError = AgentDriverError | SessionBusyError | StoreError;
//#endregion
//#region src/index.d.ts
declare const createOpenMatter: (options: OpenMatterOptions) => OpenMatterApplication;
//#endregion
export { AgentAccessError, AgentCancellationResult, AgentPermissionPolicy, AgentPermissionRequest, AgentTurnOptions, AgentTurnResult, AuthorizationError, ConsumeSummary, ContextProjectionError, EffectInput, EventBusyError, Loop, LoopDefinition, OpenMatterApplication, OpenMatterOptions, ReactionDraft, RuntimeInfrastructureError, SessionBusyError, WorkContext, WorkEventValidationError, WorkHandler, WorkHandlerResult, createOpenMatter, defineLoop };
//# sourceMappingURL=index.d.ts.map
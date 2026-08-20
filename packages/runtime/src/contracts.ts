import type {
  AgentDriver,
  AgentDriverError,
  OpenMAEvent,
} from "@openmatter/agent";
import type {
  AgentSession,
  ContextItem,
  ContextProjection,
  EffectDeliveryReceipt,
  JsonValue,
  ReactionReceipt,
  Turn,
  WorkEffect,
  WorkEvent,
} from "@openmatter/core";
import type {
  IntegrationError,
  WorkIntegration,
} from "@openmatter/integration";
import { StoreError, type OpenMatterStore } from "@openmatter/store";
import { Data, type Effect } from "effect";

export class EventBusyError extends Data.TaggedError("EventBusyError")<{
  readonly eventId: string;
  readonly retryAt: string;
  readonly message: string;
}> {}

export class AgentAccessError extends Data.TaggedError("AgentAccessError")<{
  readonly agentId: string;
  readonly message: string;
}> {}

export class ContextProjectionError extends Data.TaggedError(
  "ContextProjectionError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SessionBusyError extends Data.TaggedError("SessionBusyError")<{
  readonly bindingKey: string;
  readonly retryAt: string;
  readonly message: string;
}> {}

export class AuthorizationError extends Data.TaggedError("AuthorizationError")<{
  readonly operation: string;
  readonly message: string;
}> {}

export class WorkEventValidationError extends Data.TaggedError(
  "WorkEventValidationError",
)<{
  readonly eventId?: string;
  readonly message: string;
}> {}

export interface EffectInput {
  readonly integrationId: string;
  readonly operation: string;
  readonly input: JsonValue;
  readonly idempotencyKey?: string;
}

export interface ReactionDraft {
  readonly status: "completed" | "failed" | "cancelled";
  readonly effects: readonly WorkEffect[];
  readonly reason?: string;
}

export interface AgentTurnOptions {
  readonly context: ContextProjection;
  readonly allow?: readonly string[];
}

export interface AgentTurnResult {
  readonly session: AgentSession;
  readonly turn: Turn;
  readonly outcome: "completed" | "failed" | "cancelled" | "interrupted";
  readonly events: readonly OpenMAEvent[];
  readonly output: JsonValue | undefined;
}

export interface AgentPermissionRequest {
  readonly agentId: string;
  readonly requestId: string;
  readonly event: OpenMAEvent;
  readonly context: ContextProjection;
}

export type AgentPermissionPolicy = (
  request: AgentPermissionRequest,
) => boolean | Promise<boolean> | Effect.Effect<boolean, unknown>;

export interface WorkContext {
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
  readonly effect: (
    context: ContextProjection,
    input: EffectInput,
  ) => Effect.Effect<WorkEffect, AuthorizationError | StoreError>;
  readonly react: {
    readonly none: (reason?: string) => ReactionDraft;
    readonly effects: (
      effects: readonly WorkEffect[],
      reason?: string,
    ) => ReactionDraft;
  };
  readonly agent: (agentId: string) => {
    readonly session: (binding: {
      readonly scopeId: string;
      readonly workThreadId: string;
      readonly authority?: string;
      readonly privacyPartition: string;
    }) => {
      readonly turn: (
        input: AgentTurnOptions,
      ) => Effect.Effect<
        AgentTurnResult,
        | AgentAccessError
        | AgentDriverError
        | AuthorizationError
        | ContextProjectionError
        | SessionBusyError
        | StoreError
      >;
    };
  };
}

export type WorkHandlerResult =
  | ReactionDraft
  | Promise<ReactionDraft>
  | Effect.Effect<ReactionDraft, unknown>;

export type WorkHandler = (work: WorkContext) => WorkHandlerResult;

export interface OpenMatterOptions {
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

export interface OpenMatterApplication {
  readonly on: (
    eventType: string | readonly string[],
    handler: WorkHandler,
  ) => OpenMatterApplication;
  readonly acceptEffect: (
    event: WorkEvent,
  ) => Effect.Effect<
    ReactionReceipt,
    | EventBusyError
    | AgentDriverError
    | SessionBusyError
    | StoreError
    | WorkEventValidationError
  >;
  readonly accept: (event: WorkEvent) => Promise<ReactionReceipt>;
  readonly recoverEffectsEffect: (options?: {
    readonly limit?: number;
  }) => Effect.Effect<readonly EffectDeliveryReceipt[], StoreError>;
  readonly recoverEffects: (options?: {
    readonly limit?: number;
  }) => Promise<readonly EffectDeliveryReceipt[]>;
  readonly acceptFromEffect: (
    integrationId: string,
    input: unknown,
  ) => Effect.Effect<
    readonly ReactionReceipt[],
    | EventBusyError
    | AgentDriverError
    | IntegrationError
    | SessionBusyError
    | StoreError
    | WorkEventValidationError
  >;
  readonly acceptFrom: (
    integrationId: string,
    input: unknown,
  ) => Promise<readonly ReactionReceipt[]>;
  readonly consume: (
    events: AsyncIterable<WorkEvent>,
    options?: { readonly concurrency?: number },
  ) => Promise<ConsumeSummary>;
}

export interface ConsumeSummary {
  readonly processed: number;
  readonly failed: number;
  readonly duplicates: number;
}

export type RuntimeInfrastructureError =
  AgentDriverError | SessionBusyError | StoreError;

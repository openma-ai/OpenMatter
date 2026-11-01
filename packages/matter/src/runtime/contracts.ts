import type {
  AgentDriver,
  AgentDriverError,
  OpenMAEvent,
} from "../agent/index.js";
import type {
  AgentSession,
  ContextItem,
  ContextProjection,
  EffectDeliveryReceipt,
  FreshnessPolicy,
  JsonValue,
  MutationGuard,
  ReactionReceipt,
  Turn,
  WorkEffect,
  WorkEvent,
} from "../index.js";
import type {
  IntegrationError,
  WorkIntegration,
} from "../integration/index.js";
import { StoreError, type OpenMatterStore } from "../store/index.js";
import { Data, type Effect } from "effect";
import {
  snapshotLoopDefinition,
  type Loop as GuestLoop,
  type LoopConfig,
  type LoopDefinition,
} from "@openma/matter-loop";

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
  readonly mutation?: MutationGuard;
}

/**
 * What became of an acknowledgement (`WorkContext.acknowledge`). It never
 * fails the handler: a failure is reported here and the work goes on.
 */
export type AcknowledgementResult =
  | { readonly status: "delivered"; readonly receipt?: JsonValue }
  | {
      readonly status: "failed";
      readonly reason: string;
      readonly retryable: boolean;
    }
  | { readonly status: "uncertain"; readonly reason: string };

export interface ReactionDraft {
  readonly status: "completed" | "failed" | "cancelled";
  readonly effects: readonly WorkEffect[];
  readonly reason?: string;
}

export interface AgentTurnOptions {
  readonly context: ContextProjection;
  readonly allow?: readonly string[];
  /** Checks the Turn's conversation writes; `DEFAULT_FRESHNESS` when absent. */
  readonly freshness?: FreshnessPolicy;
}

export interface AgentTurnResult {
  readonly session: AgentSession;
  readonly turn: Turn;
  readonly outcome: "completed" | "failed" | "cancelled" | "interrupted";
  readonly events: readonly OpenMAEvent[];
  readonly output: JsonValue | undefined;
}

export interface AgentCancellationResult {
  readonly status: "requested" | "idle";
  readonly turnId?: string;
}

/**
 * What became of a steer (`session.steer`). `live` means the driver accepted
 * the instruction into the running Turn `turnId`; nothing else needs to run.
 * `queued` means it did not reach a running Turn, and the caller should run
 * it as a new Turn (the pre-steering behaviour). `reason` says why:
 * - `idle`: no Turn of this Session is running in this process;
 * - `unsupported`: the driver does not declare `steering`;
 * - `rejected`: the driver declined, e.g. the Turn just finished;
 * - `failed`: the driver call failed.
 */
export type AgentSteerResult =
  | { readonly status: "live"; readonly turnId: string }
  | {
      readonly status: "queued";
      readonly reason: "idle" | "unsupported" | "rejected" | "failed";
      readonly turnId?: string;
      readonly detail?: string;
    };

export interface AgentSteerOptions {
  /** The instruction, projected like a Turn's context. */
  readonly context: ContextProjection;
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
      readonly observation?: ContextItem["observation"];
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
  /**
   * Delivers an authorized operation now, before the Reaction, for example a
   * reaction that tells the sender their message was picked up. It is
   * authorized like `effect` but is not durable: it is not logged, a failure
   * does not fail the handler, and a retried Event may deliver it again, so
   * use it only for an idempotent, low-stakes operation. It cannot be part of
   * a Reaction.
   */
  readonly acknowledge: (
    context: ContextProjection,
    input: EffectInput,
  ) => Effect.Effect<AcknowledgementResult, AuthorizationError | StoreError>;
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
      readonly cancel: () => Effect.Effect<
        AgentCancellationResult,
        AgentAccessError | AgentDriverError | StoreError
      >;
      /** Injects an instruction into this Session's running Turn when the
       * driver supports steering; otherwise reports `queued` and changes
       * nothing. Idempotent per WorkEvent. */
      readonly steer: (
        input: AgentSteerOptions,
      ) => Effect.Effect<
        AgentSteerResult,
        | AgentAccessError
        | AuthorizationError
        | ContextProjectionError
        | StoreError
      >;
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

export interface LoopInstallContext {
  /** The validated configuration, with schema defaults filled in. */
  readonly config: LoopConfig;
}

/**
 * A Loop whose handlers run in the host process with the Effect-based
 * `WorkContext`. Loop code meant to run in an isolate uses `defineLoop` from
 * `@openma/matter-loop` instead; `app.loop` accepts both.
 */
export interface Loop {
  readonly definition: LoopDefinition;
  readonly install: (
    app: OpenMatterApplication,
    context: LoopInstallContext,
  ) => void | OpenMatterApplication;
}

export const defineLoop = (
  definition: LoopDefinition,
  install: Loop["install"],
): Loop =>
  Object.freeze({ definition: snapshotLoopDefinition(definition), install });

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
  /**
   * Installs a Loop. `config` is validated against the Loop's `configSchema`
   * and defaults are applied; an invalid configuration throws a TypeError
   * listing every problem, and nothing is installed.
   */
  readonly loop: (
    loop: Loop | GuestLoop,
    config?: JsonValue,
  ) => OpenMatterApplication;
  readonly on: (
    eventType: string | readonly string[],
    handler: WorkHandler,
  ) => OpenMatterApplication;
  /**
   * Records events of these types in their conversation, through the
   * Integration's `observe`, without running a handler for them. Handled
   * event types are recorded too. Recorded messages are what a conversation
   * write is checked against.
   */
  readonly observe: (
    eventType: string | readonly string[],
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

export {
  loopConfigSchemaProblems,
  resolveLoopConfig,
  type LoopConfig,
  type LoopConfigField,
  type LoopConfigResult,
  type LoopConfigScalar,
  type LoopConfigSchema,
  type LoopDefinition,
  type LoopRequiredBond,
  type LoopRunAs,
} from "@openma/matter-loop";

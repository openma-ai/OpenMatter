import type {
  AgentDriver,
  AgentDriverError,
  OpenMAEvent,
} from "../agent/index.js";
import {
  JsonValueSchema,
  type AgentSession,
  type ContextItem,
  type ContextProjection,
  type EffectDeliveryReceipt,
  type JsonValue,
  type ReactionReceipt,
  type Turn,
  type WorkEffect,
  type WorkEvent,
} from "../index.js";
import type {
  IntegrationError,
  WorkIntegration,
} from "../integration/index.js";
import { StoreError, type OpenMatterStore } from "../store/index.js";
import { Data, Schema, type Effect } from "effect";
import {
  loopConfigSchemaProblems,
  type LoopConfig,
  type LoopConfigSchema,
} from "./loop-config.js";

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

export interface AgentCancellationResult {
  readonly status: "requested" | "idle";
  readonly turnId?: string;
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
      readonly cancel: () => Effect.Effect<
        AgentCancellationResult,
        AgentAccessError | AgentDriverError | StoreError
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

/**
 * Whose provider identity a Loop's writes use. `app` is the Installation
 * principal; `requester` is the user who sent an attended Event. The host
 * resolves it through Bond (docs/LOOPS.md, "Execution principal").
 */
export type LoopRunAs = "app" | "requester";

/** A provider account the Loop needs, and the operations it performs there. */
export interface LoopRequiredBond {
  readonly provider: string;
  readonly operations: readonly string[];
}

export interface LoopDefinition {
  readonly id: string;
  readonly version?: string;
  readonly description?: string;
  readonly spec?: JsonValue;
  /** What a Loop instance is configured with. See `resolveLoopConfig`. */
  readonly configSchema?: LoopConfigSchema;
  /** Checked by the host against the agent's grants before enabling. */
  readonly requiredBonds?: readonly LoopRequiredBond[];
  /** Defaults to `app`. */
  readonly runAs?: LoopRunAs;
}

export interface LoopInstallContext {
  /** The validated configuration, with schema defaults filled in. */
  readonly config: LoopConfig;
}

export interface Loop {
  readonly definition: LoopDefinition;
  readonly install: (
    app: OpenMatterApplication,
    context: LoopInstallContext,
  ) => void | OpenMatterApplication;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const requiredBondsProblem = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return "requiredBonds must be a list";
  for (const bond of value) {
    if (
      typeof bond !== "object" ||
      bond === null ||
      !isNonEmptyString((bond as LoopRequiredBond).provider) ||
      !Array.isArray((bond as LoopRequiredBond).operations) ||
      (bond as LoopRequiredBond).operations.length === 0 ||
      !(bond as LoopRequiredBond).operations.every(isNonEmptyString) ||
      Object.keys(bond).some((k) => k !== "provider" && k !== "operations")
    ) {
      return "each requiredBonds entry needs a provider and a non-empty list of operations";
    }
  }
  return undefined;
};

const immutableLoopJson = <T extends JsonValue>(value: T): T => {
  const snapshot = structuredClone(value) as T;
  const freeze = (current: JsonValue): void => {
    if (current === null || typeof current !== "object") return;
    for (const nested of Array.isArray(current)
      ? current
      : Object.values(current)) {
      freeze(nested);
    }
    Object.freeze(current);
  };
  freeze(snapshot);
  return snapshot;
};

export const defineLoop = (
  definition: LoopDefinition,
  install: Loop["install"],
): Loop => {
  if (
    typeof definition.id !== "string" ||
    definition.id.length === 0 ||
    (definition.version !== undefined &&
      typeof definition.version !== "string") ||
    (definition.description !== undefined &&
      typeof definition.description !== "string") ||
    (definition.spec !== undefined &&
      !Schema.is(JsonValueSchema)(definition.spec))
  ) {
    throw new TypeError("Loop definition must contain portable JSON metadata");
  }
  const problems = [
    ...(definition.configSchema === undefined
      ? []
      : loopConfigSchemaProblems(definition.configSchema)),
    ...[requiredBondsProblem(definition.requiredBonds)].filter(
      (p): p is string => p !== undefined,
    ),
    ...(definition.runAs === undefined ||
    definition.runAs === "app" ||
    definition.runAs === "requester"
      ? []
      : ["runAs must be app or requester"]),
  ];
  if (problems.length > 0) {
    throw new TypeError(`Loop definition is invalid: ${problems.join("; ")}`);
  }
  const snapshot: LoopDefinition = Object.freeze({
    id: definition.id,
    ...(definition.version === undefined
      ? {}
      : { version: definition.version }),
    ...(definition.description === undefined
      ? {}
      : { description: definition.description }),
    ...(definition.spec === undefined
      ? {}
      : { spec: immutableLoopJson(definition.spec) }),
    ...(definition.configSchema === undefined
      ? {}
      : {
          configSchema: immutableLoopJson(
            definition.configSchema as unknown as JsonValue,
          ) as unknown as LoopConfigSchema,
        }),
    ...(definition.requiredBonds === undefined
      ? {}
      : {
          requiredBonds: immutableLoopJson(
            definition.requiredBonds as unknown as JsonValue,
          ) as unknown as readonly LoopRequiredBond[],
        }),
    ...(definition.runAs === undefined ? {} : { runAs: definition.runAs }),
  });
  return Object.freeze({ definition: snapshot, install });
};

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
  readonly loop: (loop: Loop, config?: JsonValue) => OpenMatterApplication;
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

export {
  loopConfigSchemaProblems,
  resolveLoopConfig,
  type LoopConfig,
  type LoopConfigField,
  type LoopConfigResult,
  type LoopConfigScalar,
  type LoopConfigSchema,
} from "./loop-config.js";

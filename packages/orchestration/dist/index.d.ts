import { AgentTurnResult, EffectInput, Loop, WorkContext } from "@openmatter/runtime";
import { Effect } from "effect";
import { ContextItem, ContextProjection, JsonValue } from "@openmatter/core";
//#region src/linear-agent-surface.d.ts
interface LinearAgentSurfaceProjectionInput {
  readonly organizationId: string;
  readonly appUserId: string;
  readonly oauthClientId?: string;
  readonly agentSessionId: string;
  readonly events: AgentTurnResult["events"];
  readonly maxActivities?: number;
  readonly externalUrls?: readonly {
    readonly label: string;
    readonly url: string;
  }[];
}
interface LinearAgentSurfaceOptions {
  readonly agentId: string;
  readonly initialThought?: string;
  readonly maxActivities?: number;
  readonly context?: (work: WorkContext) => readonly ContextItem[] | Promise<readonly ContextItem[]> | Effect.Effect<readonly ContextItem[], unknown>;
  readonly externalUrls?: readonly {
    readonly label: string;
    readonly url: string;
  }[] | ((input: {
    readonly work: WorkContext;
    readonly turn: AgentTurnResult;
  }) => readonly {
    readonly label: string;
    readonly url: string;
  }[] | Promise<readonly {
    readonly label: string;
    readonly url: string;
  }[]> | Effect.Effect<readonly {
    readonly label: string;
    readonly url: string;
  }[], unknown>);
}
/**
 * Explicit GUI projection for Linear's Agent Surface.
 *
 * OpenMA events stay the durable runtime facts. This function emits only the
 * finite Linear operations that an application may authorize. Raw tool
 * inputs/outputs and private thinking text are deliberately never copied.
 */
declare const projectLinearAgentSurface: (input: LinearAgentSurfaceProjectionInput) => readonly EffectInput[];
declare const linearAgentSurface: (options: LinearAgentSurfaceOptions) => Loop;
//#endregion
//#region src/coordinator-loop.d.ts
type CoordinatorThread = {
  readonly kind: "coordinator";
} | {
  readonly kind: "worker";
  readonly id: string;
};
interface CoordinatorAssociation {
  /** Stable boundary shared by the coordinator and its workers. */
  readonly scopeId: string;
  /** Required by per-run continuity; repeated events reuse the same Run id. */
  readonly runId?: string;
  /** Stable authority when one Scope spans several provider authorities. */
  readonly authority?: string;
  /** Defaults to scopeId so project context cannot cross this boundary. */
  readonly privacyPartition?: string;
  readonly thread: CoordinatorThread;
}
type CoordinatorRunAssociation = CoordinatorAssociation & {
  readonly runId: string;
};
type CoordinatorControl = "delegate" | "steer" | "cancel" | "complete";
type CallbackResult<A> = A | Promise<A> | Effect.Effect<A, unknown>;
interface CoordinatorLoopOptions {
  readonly id: string;
  readonly version?: string;
  readonly description?: string;
  /** Choose whether Coordinator and Worker Sessions persist by Scope or Run. */
  readonly continuity: "per-scope" | "per-run";
  /** Coordinator Agent. It decides whether and how project work is delegated. */
  readonly agentId: string;
  /**
   * Deployment binding for delegated Worker Sessions. The public domain
   * semantic remains `delegate`; provider/runtime selection stays here.
   * Defaults to `agentId` for single-Agent deployments.
   */
  readonly workerAgent?: string | ((input: {
    readonly work: WorkContext;
    readonly association: CoordinatorAssociation & {
      readonly thread: Extract<CoordinatorThread, {
        kind: "worker";
      }>;
    };
  }) => CallbackResult<string>);
  /** Agent-facing control surface. A simple Router needs only `delegate`. */
  readonly controls?: readonly CoordinatorControl[];
  /** Event types that request cancellation instead of starting another Turn. */
  readonly cancelSources?: string | readonly string[];
  readonly goal?: JsonValue;
  readonly sources: string | readonly string[];
  readonly associate: (work: WorkContext) => CallbackResult<CoordinatorAssociation>;
  /** Load bounded project memory, library items, or thread-local context. */
  readonly context?: (input: {
    readonly work: WorkContext;
    readonly association: CoordinatorAssociation;
  }) => CallbackResult<readonly ContextItem[]>;
  /** Host admission for synthetic continuations. Returning false consumes a stale event without a turn. */
  readonly admit?: (input: {
    readonly work: WorkContext;
    readonly association: CoordinatorAssociation;
  }) => CallbackResult<boolean>;
  /** Runs after the authoritative Agent turn boundary, including failed/cancelled outcomes. */
  readonly onTurnFinished?: (input: {
    readonly work: WorkContext;
    readonly association: CoordinatorAssociation;
    readonly context: ContextProjection;
    readonly turn: AgentTurnResult;
  }) => CallbackResult<void>;
  readonly grants?: readonly string[];
  /** Convert the completed Turn into provider-neutral Effect intents. */
  readonly effects?: (input: {
    readonly work: WorkContext;
    readonly association: CoordinatorAssociation;
    readonly turn: AgentTurnResult;
    readonly workerTurn?: AgentTurnResult;
  }) => CallbackResult<EffectInput | readonly EffectInput[] | null | undefined>;
}
interface LinearLoopOptions extends Omit<CoordinatorLoopOptions, "continuity" | "associate"> {
  readonly associate: (work: WorkContext) => CallbackResult<CoordinatorRunAssociation>;
}
declare const coordinatorLoop: (options: CoordinatorLoopOptions) => Loop;
/** Linear-inspired built-in pattern: each activation Run owns its Session. */
declare const linearLoop: (options: LinearLoopOptions) => Loop;
//#endregion
//#region src/index.d.ts
interface ClaudeTagOptions {
  readonly agentId: string;
  readonly commandVisibility?: "ephemeral" | "channel";
  readonly context?: (work: WorkContext) => readonly ContextItem[] | Promise<readonly ContextItem[]> | Effect.Effect<readonly ContextItem[], unknown>;
}
declare const claudeTag: (options: ClaudeTagOptions) => Loop;
//#endregion
export { ClaudeTagOptions, type CoordinatorAssociation, type CoordinatorControl, type CoordinatorLoopOptions, type CoordinatorRunAssociation, type CoordinatorThread, type LinearAgentSurfaceOptions, type LinearAgentSurfaceProjectionInput, type LinearLoopOptions, claudeTag, coordinatorLoop, linearAgentSurface, linearLoop, projectLinearAgentSurface };
//# sourceMappingURL=index.d.ts.map
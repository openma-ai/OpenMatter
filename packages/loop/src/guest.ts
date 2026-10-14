import { resolveLoopConfig, type LoopConfig } from "./config.js";
import { snapshotLoopDefinition, type LoopDefinition } from "./definition.js";
import { isJsonValue, type JsonValue } from "./json.js";
import type {
  AgentCancellation,
  AgentSessionBinding,
  AgentTurnInput,
  AgentTurnSummary,
  ContextItem,
  ContextProjection,
  EffectInput,
  ProjectContextInput,
  ReactionDraft,
  WorkEffect,
  WorkEvent,
} from "./types.js";

/**
 * The capabilities a host lends to Loop code for one Event. Every argument
 * and result is portable JSON, so a host can serve this object across an
 * isolate boundary (for example as an RPC stub). Loop code has no other way
 * to reach storage, credentials, providers, or the network.
 */
export interface LoopHost {
  readonly projectContext: (
    input: ProjectContextInput,
  ) => Promise<ContextProjection>;
  readonly createEffect: (
    context: ContextProjection,
    input: EffectInput,
  ) => Promise<WorkEffect>;
  readonly agentTurn: (
    agentId: string,
    binding: AgentSessionBinding,
    input: AgentTurnInput,
  ) => Promise<AgentTurnSummary>;
  readonly agentCancel: (
    agentId: string,
    binding: AgentSessionBinding,
  ) => Promise<AgentCancellation>;
}

/** What a Loop handler receives for one Event. */
export interface LoopWork {
  readonly event: WorkEvent;
  /** The instance configuration, validated and with defaults filled in. */
  readonly config: LoopConfig;
  readonly context: {
    /** The triggering Event as a ContextItem. */
    readonly event: () => ContextItem;
    readonly value: (input: {
      readonly id?: string;
      readonly kind: string;
      readonly value: JsonValue;
      readonly provenance: ContextItem["provenance"];
    }) => ContextItem;
    /** Persists a ContextProjection; only projected context can authorize effects. */
    readonly project: (
      input: ProjectContextInput,
    ) => Promise<ContextProjection>;
  };
  /** Records an authorized effect intent. The host delivers it after the Reaction commits. */
  readonly effect: (
    context: ContextProjection,
    input: EffectInput,
  ) => Promise<WorkEffect>;
  readonly react: {
    readonly none: (reason?: string) => ReactionDraft;
    readonly effects: (
      effects: readonly WorkEffect[],
      reason?: string,
    ) => ReactionDraft;
  };
  readonly agent: (agentId: string) => {
    readonly session: (binding: AgentSessionBinding) => {
      readonly turn: (input: AgentTurnInput) => Promise<AgentTurnSummary>;
      readonly cancel: () => Promise<AgentCancellation>;
    };
  };
}

export type LoopHandler = (
  work: LoopWork,
) => ReactionDraft | Promise<ReactionDraft>;

export interface LoopApp {
  /** Handles one or more Event types. A later registration for a type replaces the earlier one. */
  readonly on: (
    eventTypes: string | readonly string[],
    handler: LoopHandler,
  ) => LoopApp;
}

export interface LoopInstallContext {
  readonly config: LoopConfig;
}

/** A Loop written against `@openma/matter-loop`. */
export interface Loop {
  readonly kind: "guest";
  readonly definition: LoopDefinition;
  readonly install: (app: LoopApp, context: LoopInstallContext) => void;
}

/**
 * Defines a Loop. `definition` is plain JSON a host can read without running
 * `install`; `install` registers handlers. Make it the module's default export
 * when the host loads Loop code from a bundle.
 */
export const defineLoop = (
  definition: LoopDefinition,
  install: Loop["install"],
): Loop =>
  Object.freeze({
    kind: "guest" as const,
    definition: snapshotLoopDefinition(definition),
    install,
  });

export const isGuestLoop = (value: unknown): value is Loop =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === "guest" &&
  typeof (value as { install?: unknown }).install === "function" &&
  typeof (value as { definition?: unknown }).definition === "object";

/** A Loop with its configuration applied, ready to handle Events. */
export interface LoadedLoop {
  readonly definition: LoopDefinition;
  readonly config: LoopConfig;
  /** The Event types the Loop registered handlers for. */
  readonly eventTypes: readonly string[];
  /** Runs the handler for `event.type` with the given host capabilities. */
  readonly handle: (event: WorkEvent, host: LoopHost) => Promise<ReactionDraft>;
}

const makeId = () => globalThis.crypto.randomUUID();

const draft = (
  effects: readonly WorkEffect[],
  reason: string | undefined,
): ReactionDraft => ({
  status: "completed",
  effects,
  ...(reason === undefined ? {} : { reason }),
});

const isReactionDraft = (value: unknown): value is ReactionDraft =>
  typeof value === "object" &&
  value !== null &&
  ["completed", "failed", "cancelled"].includes(
    (value as ReactionDraft).status,
  ) &&
  Array.isArray((value as ReactionDraft).effects) &&
  ((value as ReactionDraft).reason === undefined ||
    typeof (value as ReactionDraft).reason === "string") &&
  isJsonValue(value);

/**
 * Validates `config` against the Loop's schema, runs `install` once to
 * collect handlers, and returns a `LoadedLoop`. Throws a TypeError for an
 * invalid configuration or a Loop that registers no handlers.
 */
export const loadLoop = (loop: Loop, config?: JsonValue): LoadedLoop => {
  if (!isGuestLoop(loop)) {
    throw new TypeError("loadLoop expects a Loop from @openma/matter-loop");
  }
  const definition = loop.definition;
  const resolved = resolveLoopConfig(definition.configSchema, config);
  if (!resolved.ok) {
    throw new TypeError(
      `Invalid configuration for Loop ${definition.id}: ${resolved.problems.join("; ")}`,
    );
  }
  const loopConfig = resolved.config;
  const handlers = new Map<string, LoopHandler>();
  const app: LoopApp = {
    on: (eventTypes, handler) => {
      for (const type of typeof eventTypes === "string"
        ? [eventTypes]
        : eventTypes) {
        handlers.set(type, handler);
      }
      return app;
    },
  };
  loop.install(app, { config: loopConfig });
  if (handlers.size === 0) {
    throw new TypeError(`Loop ${definition.id} registers no handlers`);
  }

  const handle = async (
    event: WorkEvent,
    host: LoopHost,
  ): Promise<ReactionDraft> => {
    const handler = handlers.get(event.type);
    if (handler === undefined) {
      throw new TypeError(
        `Loop ${definition.id} has no handler for ${event.type}`,
      );
    }
    const work: LoopWork = {
      event,
      config: loopConfig,
      context: {
        event: () => ({
          id: event.id,
          kind: "event",
          value: event as unknown as JsonValue,
          provenance: [
            {
              sourceType: "work-event",
              sourceId: event.id,
              integrationId: event.source.provider,
            },
          ],
        }),
        value: (input) => ({
          id: input.id ?? makeId(),
          kind: input.kind,
          value: input.value,
          provenance: input.provenance,
        }),
        project: (input) => host.projectContext(input),
      },
      effect: (context, input) => host.createEffect(context, input),
      react: {
        none: (reason) => draft([], reason),
        effects: (effects, reason) => draft(effects, reason),
      },
      agent: (agentId) => ({
        session: (binding) => ({
          turn: (input) => host.agentTurn(agentId, binding, input),
          cancel: () => host.agentCancel(agentId, binding),
        }),
      }),
    };
    const result = await handler(work);
    if (!isReactionDraft(result)) {
      throw new TypeError(
        `Loop ${definition.id} returned something other than a Reaction draft for ${event.type}`,
      );
    }
    return result;
  };

  return Object.freeze({
    definition,
    config: loopConfig,
    eventTypes: Object.freeze([...handlers.keys()]),
    handle,
  });
};

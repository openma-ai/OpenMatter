import type {
  ContextItem,
  ContextProjection,
  JsonValue,
} from "@openmatter/core";
import {
  defineLoop,
  type AgentTurnResult,
  type EffectInput,
  type Loop,
  type WorkContext,
} from "@openmatter/runtime";
import { Effect } from "effect";

export type CoordinatorThread =
  | { readonly kind: "coordinator" }
  | { readonly kind: "worker"; readonly id: string };

export interface CoordinatorAssociation {
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

export type CoordinatorRunAssociation = CoordinatorAssociation & {
  readonly runId: string;
};

export type CoordinatorControl = "delegate" | "steer" | "cancel" | "complete";

type CallbackResult<A> = A | Promise<A> | Effect.Effect<A, unknown>;

export interface CoordinatorLoopOptions {
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
  readonly workerAgent?:
    | string
    | ((input: {
        readonly work: WorkContext;
        readonly association: CoordinatorAssociation & {
          readonly thread: Extract<CoordinatorThread, { kind: "worker" }>;
        };
      }) => CallbackResult<string>);
  /** Agent-facing control surface. A simple Router needs only `delegate`. */
  readonly controls?: readonly CoordinatorControl[];
  /** Event types that request cancellation instead of starting another Turn. */
  readonly cancelSources?: string | readonly string[];
  readonly goal?: JsonValue;
  readonly sources: string | readonly string[];
  readonly associate: (
    work: WorkContext,
  ) => CallbackResult<CoordinatorAssociation>;
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

export interface LinearLoopOptions extends Omit<
  CoordinatorLoopOptions,
  "continuity" | "associate"
> {
  readonly associate: (
    work: WorkContext,
  ) => CallbackResult<CoordinatorRunAssociation>;
}

const resolve = <A>(
  thunk: () => CallbackResult<A>,
): Effect.Effect<A, unknown> =>
  Effect.suspend(() => {
    try {
      const result = thunk();
      if (Effect.isEffect(result)) {
        return result as Effect.Effect<A, unknown>;
      }
      if (result instanceof Promise) {
        return Effect.tryPromise({
          try: () => result,
          catch: (cause) => cause,
        });
      }
      return Effect.succeed(result);
    } catch (cause) {
      return Effect.fail(cause);
    }
  });

const assertAssociation = (
  continuity: CoordinatorLoopOptions["continuity"],
  association: CoordinatorAssociation,
): Effect.Effect<CoordinatorAssociation, TypeError> => {
  if (association.scopeId.length === 0) {
    return Effect.fail(new TypeError("Coordinator scopeId must not be empty"));
  }
  if (
    continuity === "per-run" &&
    (association.runId === undefined || association.runId.length === 0)
  ) {
    return Effect.fail(
      new TypeError(
        "Coordinator runId must not be empty for per-run continuity",
      ),
    );
  }
  if (
    association.thread.kind === "worker" &&
    association.thread.id.length === 0
  ) {
    return Effect.fail(
      new TypeError("Coordinator worker id must not be empty"),
    );
  }
  return Effect.succeed(association);
};

const workThreadIdFor = (
  loopId: string,
  continuity: CoordinatorLoopOptions["continuity"],
  association: CoordinatorAssociation,
): string => {
  const prefix =
    continuity === "per-run" ? `${loopId}:run:${association.runId!}` : loopId;
  return association.thread.kind === "coordinator"
    ? `${prefix}:coordinator`
    : `${prefix}:worker:${association.thread.id}`;
};

const associationItem = (
  work: WorkContext,
  loopId: string,
  association: CoordinatorAssociation,
): ContextItem =>
  work.context.value({
    id:
      association.thread.kind === "coordinator"
        ? `${loopId}:association:coordinator`
        : `${loopId}:association:worker:${association.thread.id}`,
    kind: "coordinator-association",
    value: {
      role: association.thread.kind,
      scopeId: association.scopeId,
      ...(association.runId === undefined ? {} : { runId: association.runId }),
      ...(association.thread.kind === "worker"
        ? { workerId: association.thread.id }
        : {}),
    },
    provenance: [{ sourceType: "loop-definition", sourceId: loopId }],
  });

/**
 * Reusable coordinator/worker Loop with Scope- or Run-scoped continuity.
 *
 * The Loop owns durable association and context projection. Delegation remains
 * an explicit Event: an Agent tool or application emits an event that
 * `associate` maps to a named worker, so no hidden workflow runtime is added.
 */
const makeCoordinatorLoop = (
  options: CoordinatorLoopOptions,
  pattern?: string,
): Loop => {
  const sources =
    typeof options.sources === "string" ? [options.sources] : options.sources;
  const grants = [...(options.grants ?? [])];
  const controls = [...(options.controls ?? ["delegate"])] as const;
  const cancelSources = new Set(
    options.cancelSources === undefined
      ? []
      : typeof options.cancelSources === "string"
        ? [options.cancelSources]
        : options.cancelSources,
  );
  const workerAgent = options.workerAgent;
  const workerAgentDefinition =
    workerAgent === undefined
      ? options.agentId
      : typeof workerAgent === "string"
        ? workerAgent
        : "extension:worker-agent";

  return defineLoop(
    {
      id: options.id,
      ...(options.version === undefined ? {} : { version: options.version }),
      description:
        options.description ?? "Coordinate durable work across Agent Sessions",
      spec: {
        preset: "coordinator-loop",
        ...(pattern === undefined ? {} : { pattern }),
        sources,
        ...(options.goal === undefined ? {} : { goal: options.goal }),
        association: {
          scope: "application-defined",
          continuity: options.continuity,
          workThread: {
            coordinator:
              options.continuity === "per-run"
                ? "one-per-scope-and-run"
                : "one-per-scope",
            worker:
              options.continuity === "per-run"
                ? "one-per-scope-run-and-worker-id"
                : "one-per-scope-and-worker-id",
          },
        },
        agents: {
          coordinator: options.agentId,
          worker: workerAgentDefinition,
          sessions: "isolated-by-work-thread",
        },
        controls: {
          scope: "bound-by-host",
          commands: controls,
          exposure: "agent-driver-binding",
          ...(cancelSources.size === 0
            ? {}
            : { cancelSources: [...cancelSources] }),
        },
        context:
          options.context === undefined
            ? "event+coordinator-association"
            : "event+coordinator-association+extension:context",
        grants,
        reaction:
          options.effects === undefined ? "terminal-none" : "terminal-effects",
      },
    },
    (app) =>
      app.on(sources, (work) =>
        Effect.gen(function* () {
          const association = yield* resolve(() =>
            options.associate(work),
          ).pipe(
            Effect.flatMap((association) =>
              assertAssociation(options.continuity, association),
            ),
          );
          if (
            options.admit &&
            !(yield* resolve(() => options.admit!({ work, association })))
          ) {
            return work.react.none(
              "Host deferred or superseded this continuation",
            );
          }
          const agentIdFor = (target: CoordinatorAssociation) => {
            if (
              target.thread.kind === "coordinator" ||
              workerAgent === undefined
            ) {
              return Effect.succeed(options.agentId);
            }
            if (typeof workerAgent === "string") {
              return Effect.succeed(workerAgent);
            }
            return resolve(() =>
              workerAgent({
                work,
                association: target as CoordinatorAssociation & {
                  readonly thread: Extract<
                    CoordinatorThread,
                    { kind: "worker" }
                  >;
                },
              }),
            );
          };
          const runProjectTurn = (
            target: CoordinatorAssociation,
            resultItems: readonly ContextItem[] = [],
          ) =>
            Effect.gen(function* () {
              const agentId = yield* agentIdFor(target);
              if (agentId.trim().length === 0) {
                return yield* Effect.fail(
                  new TypeError("Coordinator agent id must not be empty"),
                );
              }
              const workThreadId = workThreadIdFor(
                options.id,
                options.continuity,
                target,
              );
              const additionalContext =
                options.context === undefined
                  ? []
                  : yield* resolve(() =>
                      options.context!({ work, association: target }),
                    );
              const goal =
                options.goal === undefined
                  ? []
                  : [
                      work.context.value({
                        id: `${options.id}:goal`,
                        kind: "coordinator-goal",
                        value: options.goal,
                        provenance: [
                          {
                            sourceType: "loop-definition",
                            sourceId: options.id,
                          },
                        ],
                      }),
                    ];
              const context = yield* work.context.project({
                scopeId: target.scopeId,
                workThreadId,
                items: [
                  work.context.event(),
                  ...goal,
                  associationItem(work, options.id, target),
                  ...additionalContext,
                  ...resultItems,
                ],
                grants,
              });
              const turn = yield* work
                .agent(agentId)
                .session({
                  scopeId: target.scopeId,
                  workThreadId,
                  ...(target.authority === undefined
                    ? {}
                    : { authority: target.authority }),
                  privacyPartition: target.privacyPartition ?? target.scopeId,
                })
                .turn({ context, allow: grants });
              if (options.onTurnFinished)
                yield* resolve(() =>
                  options.onTurnFinished!({
                    work,
                    association: target,
                    context,
                    turn,
                  }),
                );
              return { context, turn };
            });

          let workerTurn: AgentTurnResult | undefined;
          let completed: {
            readonly context: ContextProjection;
            readonly turn: AgentTurnResult;
          };
          if (
            association.thread.kind === "worker" &&
            cancelSources.has(work.event.type)
          ) {
            const workerAgentId = yield* agentIdFor(association);
            const cancellation = yield* work
              .agent(workerAgentId)
              .session({
                scopeId: association.scopeId,
                workThreadId: workThreadIdFor(
                  options.id,
                  options.continuity,
                  association,
                ),
                ...(association.authority === undefined
                  ? {}
                  : { authority: association.authority }),
                privacyPartition:
                  association.privacyPartition ?? association.scopeId,
              })
              .cancel();
            completed = yield* runProjectTurn(
              { ...association, thread: { kind: "coordinator" } },
              [
                work.context.value({
                  id: `${options.id}:worker-cancellation:${association.thread.id}`,
                  kind: "coordinator-worker-cancellation",
                  value: {
                    workerId: association.thread.id,
                    status: cancellation.status,
                    ...(cancellation.turnId === undefined
                      ? {}
                      : { turnId: cancellation.turnId }),
                  },
                  provenance: [
                    { sourceType: "work-event", sourceId: work.event.id },
                  ],
                }),
              ],
            );
          } else {
            const first = yield* runProjectTurn(association);
            if (association.thread.kind === "coordinator") {
              completed = first;
            } else {
              workerTurn = first.turn;
              completed = yield* runProjectTurn(
                { ...association, thread: { kind: "coordinator" } },
                [
                  work.context.value({
                    id: `${options.id}:worker-result:${association.thread.id}`,
                    kind: "coordinator-worker-result",
                    value: {
                      workerId: association.thread.id,
                      outcome: first.turn.outcome,
                      ...(first.turn.output === undefined
                        ? {}
                        : { output: first.turn.output }),
                    },
                    provenance: [
                      {
                        sourceType: "agent-turn",
                        sourceId: first.turn.turn.id,
                      },
                    ],
                  }),
                ],
              );
            }
          }

          if (options.effects === undefined) {
            return work.react.none(
              "Coordinator Turn completed without effects",
            );
          }
          const planned = yield* resolve(() =>
            options.effects!({
              work,
              association,
              turn: completed.turn,
              ...(workerTurn === undefined ? {} : { workerTurn }),
            }),
          );
          const intents =
            planned === null || planned === undefined
              ? []
              : Array.isArray(planned)
                ? planned
                : [planned];
          const effects = yield* Effect.forEach(intents, (intent) =>
            work.effect(completed.context, intent),
          );
          return effects.length === 0
            ? work.react.none("Coordinator Turn completed without effects")
            : work.react.effects(effects);
        }),
      ),
  );
};

export const coordinatorLoop = (options: CoordinatorLoopOptions): Loop =>
  makeCoordinatorLoop(options);

/** Linear-inspired built-in pattern: each activation Run owns its Session. */
export const linearLoop = (options: LinearLoopOptions): Loop =>
  makeCoordinatorLoop(
    {
      ...options,
      continuity: "per-run",
      description:
        options.description ??
        "Run a Linear-style coordinator with isolated Run continuity",
    },
    "linear-loop",
  );

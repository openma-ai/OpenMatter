// Hosts Loops written against `@openma/matter-loop`. `makeLoopHost` turns the
// Effect-based WorkContext of one Event into the Promise-based LoopHost a
// guest Loop calls; `installLoadedLoop` registers a LoadedLoop's handlers. A
// host that runs Loop code in an isolate serves the LoopHost as its RPC stub
// and wraps the isolate's `handle` in a LoadedLoop.

import type * as Core from "../index.js";
import type * as Guest from "@openma/matter-loop";
import type { JsonValue } from "../index.js";
import { Effect, Either } from "effect";
import { loopObserves } from "@openma/matter-loop";
import type {
  AcknowledgementResult,
  AgentCancellationResult,
  AgentTurnOptions,
  EffectInput,
  OpenMatterApplication,
  ReactionDraft,
  WorkContext,
} from "./contracts.js";

// Guest records must stay structurally identical to the core schemas and the
// runtime's own records, in both directions.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type SessionBinding = Parameters<
  ReturnType<WorkContext["agent"]>["session"]
>[0];
type ProjectInput = Parameters<WorkContext["context"]["project"]>[0];
const sameShapes: [
  Same<Core.WorkEvent, Guest.WorkEvent>,
  Same<Core.SourceAnchor, Guest.SourceAnchor>,
  Same<Core.ContextItem, Guest.ContextItem>,
  Same<Core.ContextProjection, Guest.ContextProjection>,
  Same<Core.WorkEffect, Guest.WorkEffect>,
  Same<Core.JsonValue, Guest.JsonValue>,
  Same<EffectInput, Guest.EffectInput>,
  Same<ReactionDraft, Guest.ReactionDraft>,
  Same<AgentTurnOptions, Guest.AgentTurnInput>,
  Same<AgentCancellationResult, Guest.AgentCancellation>,
  Same<SessionBinding, Guest.AgentSessionBinding>,
  Same<ProjectInput, Guest.ProjectContextInput>,
  Same<AcknowledgementResult, Guest.AcknowledgementResult>,
] = [
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
  true,
];
void sameShapes;

/**
 * Runs one capability and turns a failure into a plain Error whose `name` is
 * the error's tag, so it survives structured cloning across an isolate.
 */
const call = async <A>(effect: Effect.Effect<A, unknown>): Promise<A> => {
  const result = await Effect.runPromise(Effect.either(effect));
  if (Either.isRight(result)) return result.right;
  const cause = result.left as { _tag?: unknown; message?: unknown };
  const error = new Error(
    typeof cause.message === "string" ? cause.message : String(result.left),
  );
  error.name = typeof cause._tag === "string" ? cause._tag : "Error";
  throw error;
};

/** The capabilities of one Event's WorkContext, as a guest Loop calls them. */
export const makeLoopHost = (work: WorkContext): Guest.LoopHost => ({
  projectContext: (input) => call(work.context.project(input)),
  createEffect: (context, input) => call(work.effect(context, input)),
  acknowledge: (context, input) => call(work.acknowledge(context, input)),
  agentTurn: async (agentId, binding, input) => {
    const result = await call(work.agent(agentId).session(binding).turn(input));
    return {
      sessionId: result.session.id,
      turnId: result.turn.id,
      outcome: result.outcome,
      ...(result.output === undefined ? {} : { output: result.output }),
      events: structuredClone(result.events) as unknown as JsonValue[],
    };
  },
  agentCancel: (agentId, binding) =>
    call(work.agent(agentId).session(binding).cancel()),
});

/** Registers every handler of a LoadedLoop on the application. */
export const installLoadedLoop = (
  app: OpenMatterApplication,
  loaded: Guest.LoadedLoop,
): OpenMatterApplication => {
  const observes = loopObserves(loaded.definition);
  if (observes.length > 0) app.observe(observes);
  return app.on(loaded.eventTypes, (work) =>
    loaded.handle(work.event, makeLoopHost(work)),
  );
};

// Session scope for Loops: which Events share one Agent Session. The config
// field a console renders as one control, and the binding a Loop passes to
// `work.agent(id).session(...)`. See docs/LOOPS.md, "Session scope".

import type { LoopConfigScalar } from "./config.js";
import type { JsonValue } from "./json.js";
import type { AgentSessionBinding } from "./types.js";

/**
 * The scopes every template names the same way. A template offers the ones
 * that make sense for it and may add its own, such as `chat_user`.
 *
 * - `global`: one Session for every Event the Loop takes in its scope.
 * - `work-item`: one Session per work item: a topic thread, an issue, a merge
 *   request. The template says what the work item is.
 * - `request`: a fresh Session for every Event.
 */
export const SESSION_SCOPES = ["global", "work-item", "request"] as const;

export type SessionScope = (typeof SESSION_SCOPES)[number];

const DESCRIPTIONS: Readonly<Record<SessionScope, string>> = {
  global: "global: one Session for everything",
  "work-item": "work-item: one Session per work item",
  request: "request: a new Session for every request",
};

/**
 * A `configSchema` field for the session scope, rendered by a console as one
 * control (`x-oma-widget: "session-scope"`) with the session settings.
 * `scopes` lists the values the template supports, standard or its own;
 * `describe` explains the template's own values and what its work item is.
 */
export const sessionScopeField = (options: {
  readonly scopes: readonly [string, ...string[]];
  readonly default?: string;
  readonly title?: string;
  readonly describe?: Readonly<Record<string, string>>;
}): LoopConfigScalar => {
  const fallback = options.default ?? options.scopes[0];
  if (!options.scopes.includes(fallback)) {
    throw new TypeError(
      `sessionScopeField: default ${fallback} is not one of the scopes`,
    );
  }
  const describe = options.describe ?? {};
  return {
    type: "string",
    enum: [...options.scopes],
    default: fallback,
    title: options.title ?? "Conversation memory",
    description: options.scopes
      .map(
        (scope) =>
          describe[scope] ??
          (Object.hasOwn(DESCRIPTIONS, scope)
            ? DESCRIPTIONS[scope as SessionScope]
            : scope),
      )
      .join("; "),
    "x-oma-widget": "session-scope",
    "x-oma-section": "session",
  };
};

/**
 * The binding for the configured scope. `threads` maps each scope the
 * template offers to the WorkThread id Events in that scope share; a value
 * not in `threads` uses `default`. Keep the ids stable: Events with the same
 * id continue the same Session.
 */
export const sessionBinding = (
  value: JsonValue | undefined,
  input: {
    readonly scopeId: string;
    readonly threads: Readonly<Record<string, string>>;
    readonly default: string;
    readonly authority?: string;
    readonly privacyPartition?: string;
  },
): AgentSessionBinding => {
  const scope =
    typeof value === "string" && Object.hasOwn(input.threads, value)
      ? value
      : input.default;
  const workThreadId = input.threads[scope];
  if (workThreadId === undefined) {
    throw new TypeError(
      `sessionBinding: no WorkThread for the default scope ${input.default}`,
    );
  }
  return {
    scopeId: input.scopeId,
    workThreadId,
    ...(input.authority === undefined ? {} : { authority: input.authority }),
    privacyPartition: input.privacyPartition ?? input.scopeId,
  };
};

// @openma/matter-loop: write Loops that run anywhere, including an isolate with
// no network. Loop code depends on this package only. See docs/LOOPS.md.

export {
  loopConfigSchemaProblems,
  resolveLoopConfig,
  type LoopConfig,
  type LoopConfigField,
  type LoopConfigResult,
  type LoopConfigScalar,
  type LoopConfigSchema,
} from "./config.js";
export {
  FRESHNESS_PRESETS,
  freshnessField,
  freshnessPolicy,
  type FreshnessPreset,
} from "./freshness.js";
export {
  SESSION_SCOPES,
  sessionBinding,
  sessionScopeField,
  type SessionScope,
} from "./session.js";
export {
  loopObserves,
  loopRunAs,
  snapshotLoopDefinition,
  type LoopDefinition,
  type LoopRequiredBond,
  type LoopRunAs,
} from "./definition.js";
export {
  defineLoop,
  isGuestLoop,
  loadLoop,
  type LoadedLoop,
  type Loop,
  type LoopApp,
  type LoopHandler,
  type LoopHost,
  type LoopInstallContext,
  type LoopWork,
} from "./guest.js";
export { isJsonValue, type JsonValue } from "./json.js";
export type * from "./types.js";

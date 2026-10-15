import { loopConfigSchemaProblems, type LoopConfigSchema } from "./config.js";
import { frozenJson, isJsonValue, type JsonValue } from "./json.js";

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

/** The portable, inspectable half of a Loop. Plain JSON. */
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

/**
 * Validates a definition and returns a frozen snapshot of it. Throws a
 * TypeError listing every problem.
 */
export const snapshotLoopDefinition = (
  definition: LoopDefinition,
): LoopDefinition => {
  if (
    typeof definition.id !== "string" ||
    definition.id.length === 0 ||
    (definition.version !== undefined &&
      typeof definition.version !== "string") ||
    (definition.description !== undefined &&
      typeof definition.description !== "string") ||
    (definition.spec !== undefined && !isJsonValue(definition.spec))
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
  return Object.freeze({
    id: definition.id,
    ...(definition.version === undefined
      ? {}
      : { version: definition.version }),
    ...(definition.description === undefined
      ? {}
      : { description: definition.description }),
    ...(definition.spec === undefined
      ? {}
      : { spec: frozenJson(definition.spec) }),
    ...(definition.configSchema === undefined
      ? {}
      : { configSchema: frozenJson(definition.configSchema) }),
    ...(definition.requiredBonds === undefined
      ? {}
      : { requiredBonds: frozenJson(definition.requiredBonds) }),
    ...(definition.runAs === undefined ? {} : { runAs: definition.runAs }),
  });
};

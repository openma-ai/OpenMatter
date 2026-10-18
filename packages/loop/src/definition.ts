import { loopConfigSchemaProblems, type LoopConfigSchema } from "./config.js";
import { frozenJson, isJsonValue, type JsonValue } from "./json.js";

/**
 * Whose provider identity a Loop's writes use. `app` is the Installation
 * principal; `requester` is the user who sent an attended Event. The host
 * resolves it through Bond (docs/LOOPS.md, "Execution principal").
 */
export type LoopRunAs = "app" | "requester";

/**
 * A provider account the Loop needs, and the operations it performs there.
 * `runAs` overrides the Loop's `runAs` for this Bond: one value for every
 * operation, or a value per operation. A bug-triage Loop, for example, reads
 * GitLab as the requester and replies in chat as the app.
 */
export interface LoopRequiredBond {
  readonly provider: string;
  readonly operations: readonly string[];
  readonly runAs?: LoopRunAs | { readonly [operation: string]: LoopRunAs };
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

const isRunAs = (value: unknown): value is LoopRunAs =>
  value === "app" || value === "requester";

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
      Object.keys(bond).some(
        (k) => k !== "provider" && k !== "operations" && k !== "runAs",
      )
    ) {
      return "each requiredBonds entry needs a provider and a non-empty list of operations";
    }
    const { provider, operations, runAs } = bond as LoopRequiredBond;
    if (runAs === undefined || isRunAs(runAs)) continue;
    if (typeof runAs !== "object" || runAs === null || Array.isArray(runAs)) {
      return `requiredBonds ${provider}.runAs must be app, requester, or a map of operations`;
    }
    for (const [operation, value] of Object.entries(runAs)) {
      if (!operations.includes(operation)) {
        return `requiredBonds ${provider}.runAs names ${operation}, which is not in its operations`;
      }
      if (!isRunAs(value)) {
        return `requiredBonds ${provider}.runAs.${operation} must be app or requester`;
      }
    }
  }
  return undefined;
};

/**
 * Whose identity one provider operation of the Loop uses: the operation's
 * own `runAs`, then its Bond's, then the Loop's, then `app`. The host turns
 * the answer into a Bond principal request. `requester` takes effect only
 * for attended Events; Bond refuses it for an unattended one rather than
 * borrowing a person's link (docs/LOOPS.md, "Execution principal").
 */
export const loopRunAs = (
  definition: Pick<LoopDefinition, "requiredBonds" | "runAs">,
  provider: string,
  operation: string,
): LoopRunAs => {
  const bonds = (definition.requiredBonds ?? []).filter(
    (b) => b.provider === provider,
  );
  const bond = bonds.find((b) => b.operations.includes(operation)) ?? bonds[0];
  const declared = bond?.runAs;
  if (isRunAs(declared)) return declared;
  const perOperation = declared?.[operation];
  if (isRunAs(perOperation)) return perOperation;
  return definition.runAs ?? "app";
};

/**
 * The event types a Loop records in their conversation without handling
 * them, from `spec.observes`. A conversation write, such as a reply, is
 * checked against them (docs/TURN_TOOLS.md).
 */
export const loopObserves = (
  definition: Pick<LoopDefinition, "spec">,
): readonly string[] => {
  const spec = definition.spec;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return [];
  }
  const observes = (spec as { readonly [key: string]: JsonValue }).observes;
  return Array.isArray(observes)
    ? observes.filter((t): t is string => typeof t === "string" && t !== "")
    : [];
};

const observesProblem = (spec: JsonValue | undefined): string | undefined => {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return undefined;
  }
  const observes = (spec as { readonly [key: string]: JsonValue }).observes;
  return observes === undefined ||
    (Array.isArray(observes) && observes.every(isNonEmptyString))
    ? undefined
    : "spec.observes must be a list of event types";
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
    ...[
      requiredBondsProblem(definition.requiredBonds),
      observesProblem(definition.spec),
    ].filter((p): p is string => p !== undefined),
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

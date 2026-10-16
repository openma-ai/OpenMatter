import {
  JsonValueSchema,
  MutationIntentSchema,
  MutationResultSchema,
  type JsonValue,
  type MutationIntent,
  type MutationResult,
  type StateObservation,
} from "../index.js";
import { Data, Effect, Schema } from "effect";

export type {
  MutationIntent,
  MutationResult,
  StateObservation,
} from "../index.js";

export class MutationError extends Data.TaggedError("MutationError")<{
  readonly code:
    | "invalid-intent"
    | "idempotency-conflict"
    | "transaction-failed"
    | "unsupported";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ObservedState extends StateObservation {
  readonly exists: boolean;
  readonly value?: JsonValue;
}
export interface MutationTransaction {
  readonly read: (resourceId: string) => ObservedState;
  readonly set: (resourceId: string, value: JsonValue) => ObservedState;
  readonly delete: (resourceId: string) => ObservedState;
}
export type MutationApply = (
  tx: MutationTransaction,
  intent: MutationIntent,
) => JsonValue;
export interface MutationRecord {
  readonly intent: MutationIntent;
  readonly result: MutationResult;
}
/** All methods run in ONE atomic storage transaction, including the receipt.
 * Custom adapters must roll back on exceptions. No network/file side effects. */
export interface MutationBackendTransaction {
  readonly read: (authority: string, resourceId: string) => ObservedState;
  readonly write: (state: ObservedState) => void;
  readonly receipt: (
    authority: string,
    operationId: string,
  ) => MutationRecord | undefined;
  readonly record: (record: MutationRecord) => void;
}
export interface MutationBackend {
  readonly atomic: <A>(body: (tx: MutationBackendTransaction) => A) => A;
  readonly read: (authority: string, resourceId: string) => ObservedState;
  readonly close: () => void;
}
export interface MutationStore {
  readonly guarantee: "atomic";
  readonly read: (
    authority: string,
    resourceId: string,
  ) => Effect.Effect<ObservedState, MutationError>;
  readonly execute: (
    intent: MutationIntent,
    apply: MutationApply,
  ) => Effect.Effect<MutationResult, MutationError>;
  readonly close: Effect.Effect<void, MutationError>;
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
const attempt = <A>(body: () => A) =>
  Effect.try({
    try: body,
    catch: (cause) =>
      cause instanceof MutationError
        ? cause
        : new MutationError({
            code: "transaction-failed",
            message: "Mutation transaction failed",
            cause,
          }),
  });
const invalid = (message: string): never => {
  throw new MutationError({ code: "invalid-intent", message });
};

/** Native Store primitive: captures the intent now, executes later.
 * Storage adapters own the atomic boundary. */
export const makeMutationStore = (backend: MutationBackend): MutationStore => ({
  guarantee: "atomic",
  read: (authority, resourceId) =>
    attempt(() => structuredClone(backend.read(authority, resourceId))),
  execute: (input, apply) => {
    let intent: MutationIntent;
    try {
      if (!Schema.is(MutationIntentSchema)(input))
        invalid("Expected a portable mutation intent");
      intent = structuredClone(input);
      const ids = new Set<string>();
      for (const observed of intent.preconditions) {
        if (
          observed.authority !== intent.authority ||
          ids.has(observed.resourceId)
        )
          invalid(
            "Conditions must be unique and bound to the intent authority",
          );
        ids.add(observed.resourceId);
      }
    } catch (cause) {
      return Effect.fail(
        cause instanceof MutationError
          ? cause
          : new MutationError({
              code: "invalid-intent",
              message: "Invalid mutation intent",
              cause,
            }),
      );
    }
    return attempt(() =>
      backend.atomic((tx) => {
        const prior = tx.receipt(intent.authority, intent.operationId);
        if (prior) {
          if (canonical(prior.intent) !== canonical(intent))
            throw new MutationError({
              code: "idempotency-conflict",
              message: "Operation identity reused with a different intent",
            });
          return structuredClone(prior.result);
        }
        const conflicts = intent.preconditions.flatMap((condition) => {
          const actual = tx.read(intent.authority, condition.resourceId);
          return actual.revision === condition.revision
            ? []
            : [
                {
                  resourceId: condition.resourceId,
                  expectedRevision: condition.revision,
                  actualRevision: actual.revision,
                },
              ];
        });
        if (conflicts.length) {
          const result: MutationResult = {
            status: "conflict",
            operationId: intent.operationId,
            effect: "not-applied",
            conflicts,
          };
          tx.record({ intent, result });
          return structuredClone(result);
        }
        let active = true;
        const staged = new Map<string, ObservedState>();
        const read = (resourceId: string): ObservedState => {
          if (!active) invalid("Mutation transaction is closed");
          if (
            !intent.preconditions.some(
              (condition) => condition.resourceId === resourceId,
            )
          )
            invalid("Resource was not declared in the read set");
          return structuredClone(
            staged.get(resourceId) ?? tx.read(intent.authority, resourceId),
          );
        };
        const write = (resourceId: string, value?: JsonValue) => {
          read(resourceId);
          if (value !== undefined && !Schema.is(JsonValueSchema)(value))
            invalid("State must be portable JSON");
          const state: ObservedState = {
            authority: intent.authority,
            resourceId,
            revision: globalThis.crypto.randomUUID(),
            exists: value !== undefined,
            ...(value === undefined ? {} : { value: structuredClone(value) }),
          };
          staged.set(resourceId, state);
          return structuredClone(state);
        };
        let value: JsonValue;
        try {
          value = apply(
            {
              read,
              set: (id, value) => write(id, value),
              delete: (id) => write(id),
            },
            structuredClone(intent),
          );
          if (!Schema.is(JsonValueSchema)(value))
            invalid("Mutation handler must return synchronous portable JSON");
        } finally {
          active = false;
        }
        for (const state of staged.values()) tx.write(state);
        const result: MutationResult = {
          status: "committed",
          operationId: intent.operationId,
          value: structuredClone(value),
          observations: [...staged.keys()].map((resourceId) => {
            const { authority, revision } = tx.read(
              intent.authority,
              resourceId,
            );
            return { authority, resourceId, revision };
          }),
        };
        if (!Schema.is(MutationResultSchema)(result))
          invalid("Invalid mutation result");
        tx.record({ intent, result });
        return structuredClone(result);
      }),
    );
  },
  close: attempt(backend.close),
});

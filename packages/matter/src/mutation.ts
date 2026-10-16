import { Schema } from "effect";
import { JsonValueSchema } from "./json.js";

/** A host-scoped observation. null means this resource has never existed. */
export const StateObservationSchema = Schema.Struct({
  authority: Schema.NonEmptyString,
  resourceId: Schema.NonEmptyString,
  revision: Schema.NullOr(Schema.String),
});
export type StateObservation = typeof StateObservationSchema.Type;

export const MutationGuardSchema = Schema.Struct({
  authority: Schema.NonEmptyString,
  preconditions: Schema.Array(StateObservationSchema),
  guarantee: Schema.Literal("atomic", "best-effort"),
});
export type MutationGuard = typeof MutationGuardSchema.Type;

export const MutationIntentSchema = Schema.Struct({
  authority: Schema.NonEmptyString,
  operationId: Schema.NonEmptyString,
  operation: Schema.NonEmptyString,
  input: JsonValueSchema,
  preconditions: Schema.Array(StateObservationSchema),
});
export type MutationIntent = typeof MutationIntentSchema.Type;

export const MutationConflictSchema = Schema.Struct({
  resourceId: Schema.String,
  expectedRevision: Schema.NullOr(Schema.String),
  actualRevision: Schema.NullOr(Schema.String),
});
export const MutationResultSchema = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("committed"),
    operationId: Schema.String,
    value: JsonValueSchema,
    observations: Schema.Array(StateObservationSchema),
  }),
  Schema.Struct({
    status: Schema.Literal("conflict"),
    operationId: Schema.String,
    effect: Schema.Literal("not-applied"),
    conflicts: Schema.Array(MutationConflictSchema),
  }),
);
export type MutationResult = typeof MutationResultSchema.Type;

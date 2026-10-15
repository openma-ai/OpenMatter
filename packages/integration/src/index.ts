import {
  JsonValueSchema,
  type JsonValue,
  type WorkEffect,
  type WorkEvent,
  type MutationResult,
} from "@openmatter/core";
import { Context, Data, Layer, Schema, type Effect } from "effect";

export class IntegrationError extends Data.TaggedError("IntegrationError")<{
  readonly message: string;
  readonly retryable: boolean;
  /** Provider-authoritative retry time when a rate limit supplies one. */
  readonly retryAt?: string;
  readonly cause?: unknown;
  /** Only assert not-applied when the provider guarantees no business effect. */
  readonly effectState?: "not-applied" | "unknown";
}> {}

export interface ProviderDeliveryResult {
  readonly providerReceipt?: JsonValue;
}

export const ProviderDeliveryResultSchema = Schema.Struct({
  providerReceipt: Schema.optional(JsonValueSchema),
}).annotations({ identifier: "ProviderDeliveryResult" });

export interface IntegrationManifest {
  readonly id: string;
  readonly displayName: string;
  readonly events: readonly string[];
  readonly operations: readonly string[];
}

export interface WorkIntegration {
  readonly manifest: IntegrationManifest;
  readonly ingest: (
    input: unknown,
  ) => Effect.Effect<readonly WorkEvent[], IntegrationError>;
  readonly deliver: (
    effect: WorkEffect,
  ) => Effect.Effect<ProviderDeliveryResult, IntegrationError>;
  /** Absent operations fail closed for guarded Effects. The adapter owns both
   * the comparison and the actual write; a local preflight is not remote CAS. */
  readonly conditionalWrites?: Readonly<
    Record<
      string,
      {
        readonly guarantee: "atomic" | "best-effort";
        readonly deliver: (
          effect: WorkEffect,
        ) => Effect.Effect<MutationResult, IntegrationError>;
      }
    >
  >;
}

export type WorkIntegrationRegistry = ReadonlyMap<string, WorkIntegration>;

export const WorkIntegrations = Context.GenericTag<WorkIntegrationRegistry>(
  "@openmatter/integration/WorkIntegrations",
);

export const integrationLayer = (
  integrations: Readonly<Record<string, WorkIntegration>>,
) => Layer.succeed(WorkIntegrations, new Map(Object.entries(integrations)));

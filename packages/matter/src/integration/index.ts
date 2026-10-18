import {
  JsonValueSchema,
  type ConversationObservation,
  type JsonValue,
  type WorkEffect,
  type WorkEvent,
  type MutationResult,
} from "../index.js";
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
  /** Operations an Agent may call during its Turn, described as tools. The
   * Turn's `allow` still decides which are offered. */
  readonly tools?: Readonly<
    Record<
      string,
      {
        readonly description: string;
        readonly inputSchema: JsonValue;
        /**
         * The call writes to the triggering event's conversation, so it is
         * checked against newer messages under the Turn's freshness policy.
         * `best-effort`: the check and the call record are one transaction,
         * but the provider write is not conditional.
         */
        readonly freshness?: "best-effort";
      }
    >
  >;
}

export interface WorkIntegration {
  readonly manifest: IntegrationManifest;
  readonly ingest: (
    input: unknown,
  ) => Effect.Effect<readonly WorkEvent[], IntegrationError>;
  readonly deliver: (
    effect: WorkEffect,
  ) => Effect.Effect<ProviderDeliveryResult, IntegrationError>;
  /**
   * The event as a conversation message, or undefined when it is not one.
   * The runtime records observed events with it, so conversation writes can
   * be checked for freshness. Pure: no I/O.
   */
  readonly observe?: (event: WorkEvent) => ConversationObservation | undefined;
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
  "@openma/matter/integration/WorkIntegrations",
);

export const integrationLayer = (
  integrations: Readonly<Record<string, WorkIntegration>>,
) => Layer.succeed(WorkIntegrations, new Map(Object.entries(integrations)));

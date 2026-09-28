import { JsonValue, WorkEffect, WorkEvent } from "@openmatter/core";
import { Context, Effect, Layer, Schema } from "effect";
//#region src/index.d.ts
declare const IntegrationError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
  readonly _tag: "IntegrationError";
} & Readonly<A>;
declare class IntegrationError extends IntegrationError_base<{
  readonly message: string;
  readonly retryable: boolean;
  /** Provider-authoritative retry time when a rate limit supplies one. */
  readonly retryAt?: string;
  readonly cause?: unknown;
}> {}
interface ProviderDeliveryResult {
  readonly providerReceipt?: JsonValue;
}
declare const ProviderDeliveryResultSchema: Schema.Struct<{
  providerReceipt: Schema.optional<Schema.declare<JsonValue, JsonValue, readonly [], never>>;
}>;
interface IntegrationManifest {
  readonly id: string;
  readonly displayName: string;
  readonly events: readonly string[];
  readonly operations: readonly string[];
}
interface WorkIntegration {
  readonly manifest: IntegrationManifest;
  readonly ingest: (input: unknown) => Effect.Effect<readonly WorkEvent[], IntegrationError>;
  readonly deliver: (effect: WorkEffect) => Effect.Effect<ProviderDeliveryResult, IntegrationError>;
}
type WorkIntegrationRegistry = ReadonlyMap<string, WorkIntegration>;
declare const WorkIntegrations: Context.Tag<WorkIntegrationRegistry, WorkIntegrationRegistry>;
declare const integrationLayer: (integrations: Readonly<Record<string, WorkIntegration>>) => Layer.Layer<WorkIntegrationRegistry, never, never>;
//#endregion
export { IntegrationError, IntegrationManifest, ProviderDeliveryResult, ProviderDeliveryResultSchema, WorkIntegration, WorkIntegrationRegistry, WorkIntegrations, integrationLayer };
//# sourceMappingURL=index.d.ts.map
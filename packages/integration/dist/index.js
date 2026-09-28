import { JsonValueSchema } from "@openmatter/core";
import { Context, Data, Layer, Schema } from "effect";
//#region src/index.ts
var IntegrationError = class extends Data.TaggedError("IntegrationError") {};
const ProviderDeliveryResultSchema = Schema.Struct({ providerReceipt: Schema.optional(JsonValueSchema) }).annotations({ identifier: "ProviderDeliveryResult" });
const WorkIntegrations = Context.GenericTag("@openmatter/integration/WorkIntegrations");
const integrationLayer = (integrations) => Layer.succeed(WorkIntegrations, new Map(Object.entries(integrations)));
//#endregion
export { IntegrationError, ProviderDeliveryResultSchema, WorkIntegrations, integrationLayer };

//# sourceMappingURL=index.js.map
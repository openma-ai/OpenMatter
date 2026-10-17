// The Feishu Integration: verified events as Events, and messages, replies,
// reactions, and card updates as Effects. It depends on the credentials port
// only, never on the Binding beside it.

export {
  makeFeishuClient,
  makeFeishuCredentialsFor,
  type FeishuClient,
  type FeishuCredentialOption,
  type FeishuCredentialResolver,
  type FeishuCredentialSource,
  type FeishuCredentials,
  type FeishuCredentialsFor,
} from "./client.js";
export {
  FEISHU_OPERATIONS,
  feishuMarkdownCard,
  makeFeishuDelivery,
  type FeishuEffectOperation,
} from "./delivery.js";

export {
  FEISHU_EVENT_TYPES,
  feishuDeliveryId,
  feishuEventId,
  normalizeFeishuEvents,
} from "./events.js";
export {
  FeishuHttpIngressError,
  FeishuHttpSubmissionError,
  decodeFeishuHttpRequest,
  decryptFeishuPayload,
  feishuSignature,
  makeFeishuHttpEndpoint,
  type FeishuChallenge,
  type FeishuEventInput,
  type FeishuHttpEndpointOptions,
  type FeishuWebhookOptions,
} from "./http.js";
export {
  makeFeishuIntegration,
  type FeishuIntegrationOptions,
} from "./integration.js";
export { withoutFeishuCredentials } from "./shared.js";
export {
  feishuAgent,
  feishuTemplates,
  templateMarkdownCard,
} from "./templates.js";

import type { WorkIntegration } from "@openma/matter/integration";
import {
  makeFeishuClient,
  makeFeishuCredentialsFor,
  type FeishuCredentialOption,
} from "./client.js";
import { FEISHU_OPERATIONS, makeFeishuDelivery } from "./delivery.js";
import { FEISHU_EVENT_TYPES, normalizeFeishuEvents } from "./events.js";

export interface FeishuIntegrationOptions {
  /**
   * Credentials for replies: fixed `{ baseUrl, token }`, or a resolver keyed
   * by the Event authority, normally the Bond's app principal (the bot's
   * tenant token).
   */
  readonly credentials: FeishuCredentialOption;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => string;
}

/**
 * The Feishu work integration: `ingest` takes a `FeishuEventInput` from the
 * webhook endpoint or the long-connection source, and `deliver` posts
 * messages, replies, reactions, and card updates as the bot.
 */
export const makeFeishuIntegration = (
  options: FeishuIntegrationOptions,
): WorkIntegration => {
  const clock = options.clock ?? (() => new Date().toISOString());
  const client = makeFeishuClient({
    credentialsFor: makeFeishuCredentialsFor(options.credentials),
    fetch: options.fetch ?? ((...args) => globalThis.fetch(...args)),
  });
  return {
    manifest: {
      id: "feishu",
      displayName: "Feishu",
      events: FEISHU_EVENT_TYPES,
      operations: FEISHU_OPERATIONS,
    },
    ingest: (input) => normalizeFeishuEvents(input, clock),
    deliver: makeFeishuDelivery(client),
  };
};

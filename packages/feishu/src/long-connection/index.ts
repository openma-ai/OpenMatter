// The Feishu long connection: events over an outbound WebSocket, for
// self-built apps that should not expose a public URL. Node only. The
// connection itself is the official SDK's WSClient (`@larksuiteoapi/node-sdk`,
// an optional peer); this module adapts it to a host's long-connection
// runtime and never lets the SDK parse or flatten the envelope.

import { feishuEndpoints } from "../bond/http.js";
import { feishuDeliveryId } from "../bond/integration/events.js";
import type { FeishuEventInput } from "../bond/integration/http.js";
import { isRecord, nonEmptyString } from "../bond/integration/shared.js";

/**
 * One event as a long-connection runtime receives it. Structurally the same
 * as `ReceivedEnvelope` of `@openma/matter-host-local/runtime`. The runtime
 * calls `ack` after it stored the event. Feishu is told the event was
 * delivered only when `ack` ran; otherwise the SDK reports a failure and
 * Feishu redelivers it.
 */
export interface FeishuReceivedEnvelope {
  readonly integrationId: string;
  /** `feishuDeliveryId(authority, envelope)`, the inbox item id. */
  readonly idempotencyKey: string;
  readonly eventType: string;
  readonly body: FeishuEventInput;
  readonly ack: () => Promise<void>;
}

/** The subset of the SDK's WSClient this module uses. */
export interface FeishuWsClient {
  readonly start: (params: {
    readonly eventDispatcher: {
      readonly invoke: (
        data: unknown,
        params?: { readonly needCheck?: boolean },
      ) => Promise<unknown>;
    };
  }) => Promise<void>;
  readonly close: (params?: { readonly force?: boolean }) => void;
}

export interface FeishuWsClientParams {
  readonly appId: string;
  readonly appSecret: string;
  /** `https://open.feishu.cn` or `https://open.larksuite.com`. */
  readonly domain: string;
  readonly onReady: () => void;
  readonly onError: (error: Error) => void;
  readonly onReconnecting: () => void;
  readonly onReconnected: () => void;
}

export type FeishuConnectionState =
  | { readonly state: "connected" }
  | { readonly state: "reconnecting" }
  /** The SDK gave up, for example on revoked credentials. Restart to retry. */
  | { readonly state: "failed"; readonly error: Error };

export interface FeishuLongConnectionOptions {
  /** The open or accounts origin; selects Feishu or Lark. */
  readonly baseUrl: string;
  readonly appId: string;
  readonly appSecret: string;
  /** Who received the events, chosen by the host (for example a Bond id). */
  readonly authority: string;
  /** The integration the events are for. Default `"feishu"`. */
  readonly integrationId?: string;
  /** From `inspectFeishuApp`; decides mentions. */
  readonly botOpenId?: string;
  /**
   * The answer to a `card.action.trigger` callback, such as a toast. A Loop
   * cannot answer within Feishu's 3 s budget. Default `{}`.
   */
  readonly cardActionResponse?: unknown;
  readonly onState?: (state: FeishuConnectionState) => void;
  /**
   * Builds the WebSocket client. Defaults to the SDK's `WSClient` with
   * automatic reconnection. Tests and hosts with their own transport pass
   * one in.
   */
  readonly createClient?: (
    params: FeishuWsClientParams,
  ) => FeishuWsClient | Promise<FeishuWsClient>;
}

/** Structurally the `LongConnectionSource` of `@openma/matter-host-local/runtime`. */
export interface FeishuLongConnectionSource {
  readonly start: (
    onEnvelope: (envelope: FeishuReceivedEnvelope) => Promise<void>,
  ) => Promise<void>;
  readonly stop: () => Promise<void>;
}

const SELF_BUILT_APP_ID = /^cli_[0-9a-fA-F]{16}$/;

const sdkClient = async (
  params: FeishuWsClientParams,
): Promise<FeishuWsClient> => {
  let sdk: {
    readonly WSClient: new (options: Record<string, unknown>) => FeishuWsClient;
  };
  try {
    sdk = (await import("@larksuiteoapi/node-sdk")) as unknown as typeof sdk;
  } catch (cause) {
    throw new Error(
      "The Feishu long connection needs the optional peer @larksuiteoapi/node-sdk",
      { cause },
    );
  }
  return new sdk.WSClient({
    appId: params.appId,
    appSecret: params.appSecret,
    domain: params.domain,
    autoReconnect: true,
    loggerLevel: 1, // error
    onReady: params.onReady,
    onError: params.onError,
    onReconnecting: params.onReconnecting,
    onReconnected: params.onReconnected,
  });
};

/**
 * A long-connection source for one self-built app. Each event is handed to
 * `onEnvelope` as the full v2 envelope wrapped in a `FeishuEventInput`, the
 * same input the webhook endpoint produces. The SDK answers Feishu only
 * after the host stored the event and called `ack`; if `onEnvelope` rejects
 * or returns without acking, the SDK reports a failure and Feishu redelivers. Events
 * that arrive after `stop` began are refused, not stored.
 */
export const makeFeishuLongConnectionSource = (
  options: FeishuLongConnectionOptions,
): FeishuLongConnectionSource => {
  const { open } = feishuEndpoints(options.baseUrl);
  // The SDK's start() logs and returns without connecting or calling onError
  // for an app id of another shape, which would look like a healthy start.
  if (!SELF_BUILT_APP_ID.test(options.appId)) {
    throw new Error(
      "The Feishu long connection needs a self-built app id (cli_ and 16 hex digits)",
    );
  }
  const integrationId = options.integrationId ?? "feishu";
  const createClient = options.createClient ?? sdkClient;
  let client: FeishuWsClient | undefined;
  let deliver:
    ((envelope: FeishuReceivedEnvelope) => Promise<void>) | undefined;
  let stopped = true;

  const state = (next: FeishuConnectionState) => {
    try {
      options.onState?.(next);
    } catch {
      // Observability hooks must not change delivery.
    }
  };

  const invoke = async (data: unknown): Promise<unknown> => {
    if (stopped || deliver === undefined) {
      throw new Error("The Feishu long connection is stopping");
    }
    if (
      !isRecord(data) ||
      data.schema !== "2.0" ||
      !isRecord(data.header) ||
      !nonEmptyString(data.header.event_type)
    ) {
      // A v1 or malformed frame cannot be normalized; acknowledging it
      // avoids a redelivery loop.
      return undefined;
    }
    if (
      data.header.app_id !== undefined &&
      data.header.app_id !== options.appId
    ) {
      throw new Error("Feishu event is for another app");
    }
    const idempotencyKey = feishuDeliveryId(options.authority, data);
    if (idempotencyKey === undefined) return undefined;
    const eventType = data.header.event_type;
    let acknowledged = false;
    await deliver({
      integrationId,
      idempotencyKey,
      eventType,
      ack: async () => {
        acknowledged = true;
      },
      body: {
        kind: "feishu.event",
        authority: options.authority,
        transport: "long_connection",
        ...(options.botOpenId === undefined
          ? {}
          : { botOpenId: options.botOpenId }),
        envelope: data as FeishuEventInput["envelope"],
      },
    });
    // A runtime reports a failed write instead of rejecting, so only the
    // ack proves the event is stored.
    if (!acknowledged) {
      throw new Error(`Feishu event ${idempotencyKey} was not stored`);
    }
    return eventType === "card.action.trigger"
      ? (options.cardActionResponse ?? {})
      : undefined;
  };

  return {
    start: async (onEnvelope) => {
      deliver = onEnvelope;
      stopped = false;
      if (client !== undefined) return;
      const created = await createClient({
        appId: options.appId,
        appSecret: options.appSecret,
        domain: open,
        onReady: () => state({ state: "connected" }),
        onReconnected: () => state({ state: "connected" }),
        onReconnecting: () => state({ state: "reconnecting" }),
        onError: (error) => state({ state: "failed", error }),
      });
      try {
        await created.start({ eventDispatcher: { invoke } });
      } catch (cause) {
        stopped = true;
        try {
          created.close({ force: true });
        } catch {
          // The failed client is discarded either way.
        }
        throw cause;
      }
      client = created;
    },
    stop: async () => {
      stopped = true;
      const current = client;
      client = undefined;
      current?.close({ force: true });
    },
  };
};

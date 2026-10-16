import { SocketModeClient } from "@slack/socket-mode";
import type { DurableInbox } from "@openma/matter/inbox";
import type { OpenMatterApplication } from "@openma/matter/runtime";
import {
  makeLocalLongConnectionRuntime,
  type LocalLongConnectionRuntime,
  type LocalRuntimeError,
  type LongConnectionSource,
  type ReceivedEnvelope,
} from "./runtime/index.js";

export * from "./runtime/index.js";

export interface SocketModeEnvelope {
  readonly type: string;
  readonly envelope_id: string;
  readonly body: unknown;
  readonly ack: (payload?: unknown) => Promise<void>;
}

export type SocketModeListener = (
  envelope: SocketModeEnvelope,
) => Promise<void> | void;

export interface SocketModeClientPort {
  readonly on: (event: string, listener: SocketModeListener) => unknown;
  readonly off: (event: string, listener?: SocketModeListener) => unknown;
  readonly start: () => Promise<unknown>;
  readonly disconnect: () => Promise<void>;
}

export interface LocalSlackRuntimeOptions {
  readonly appToken: string;
  readonly application: OpenMatterApplication;
  /** Durable transport inbox. Slack is acknowledged only after enqueue. */
  readonly inbox: DurableInbox;
  readonly client?: SocketModeClientPort;
  readonly clock?: () => number;
  readonly retryDelayMs?: number;
  readonly maxAttempts?: number;
  readonly inboxOwnerId?: string;
  readonly inboxLeaseMs?: number;
  readonly inboxPollIntervalMs?: number;
  readonly inboxBatchSize?: number;
  readonly inboxConcurrency?: number;
  /** Host-owned durable outbox recovery cadence. Set false to use an external
   * scheduler instead. */
  readonly recoveryIntervalMs?: number | false;
  readonly onError?: (error: LocalRuntimeError) => void;
}

export type LocalSlackRuntime = LocalLongConnectionRuntime;

const socketInput = (eventType: string, body: unknown): unknown =>
  eventType === "slash_commands" &&
  typeof body === "object" &&
  body !== null &&
  !Array.isArray(body)
    ? { type: "slash_command", ...body }
    : body;

/**
 * Adapts a Slack Socket Mode client to a LongConnectionSource. The listener is
 * attached once per start and removed on stop; the client connects once and
 * disconnects once, and a failed disconnect may be retried.
 */
export const socketModeSource = (
  client: SocketModeClientPort,
): LongConnectionSource => {
  let listener: SocketModeListener | undefined;
  let connected = false;
  const detach = () => {
    if (listener === undefined) return;
    client.off("slack_event", listener);
    listener = undefined;
  };
  return {
    start: async (onEnvelope) => {
      if (listener === undefined) {
        const registered: SocketModeListener = (envelope) => {
          const received: ReceivedEnvelope = {
            integrationId: "slack",
            idempotencyKey:
              typeof envelope.envelope_id === "string" &&
              envelope.envelope_id.length > 0
                ? `slack:${envelope.envelope_id}`
                : "",
            eventType: envelope.type,
            body: socketInput(envelope.type, envelope.body),
            ack: (payload?: unknown) => envelope.ack(payload),
          };
          return onEnvelope(received);
        };
        listener = registered;
        client.on("slack_event", registered);
      }
      if (connected) return;
      try {
        await client.start();
        connected = true;
      } catch (cause) {
        detach();
        throw cause;
      }
    },
    stop: async () => {
      detach();
      if (!connected) return;
      await client.disconnect();
      connected = false;
    },
  };
};

export const makeLocalSlackRuntime = (
  options: LocalSlackRuntimeOptions,
): LocalSlackRuntime => {
  const client =
    options.client ??
    (new SocketModeClient({
      appToken: options.appToken,
    }) as SocketModeClientPort);
  const { appToken: _appToken, client: _client, ...rest } = options;
  return makeLocalLongConnectionRuntime({
    ...rest,
    source: socketModeSource(client),
    envelopeLabel: "Slack",
    connectionLabel: "Slack Socket Mode",
  });
};

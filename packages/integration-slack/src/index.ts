import {
  JsonValueSchema,
  type JsonValue,
  type WorkEvent,
} from "@openmatter/core";
import type { WorkIntegration } from "@openmatter/integration";
import { IntegrationError } from "@openmatter/integration";
import { Data, Effect, Schema } from "effect";

export class SlackRequestVerificationError extends Data.TaggedError(
  "SlackRequestVerificationError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SlackHttpIngressError extends Data.TaggedError(
  "SlackHttpIngressError",
)<{
  readonly message: string;
  readonly status: 400 | 401;
  readonly cause?: unknown;
}> {}

export interface SlackRequestVerificationInput {
  readonly signingSecret: string;
  readonly rawBody: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly now?: () => number;
  readonly toleranceSeconds?: number;
}

const bytesFromHex = (hex: string): Uint8Array<ArrayBuffer> | undefined => {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
};

export const verifySlackRequest = (
  input: SlackRequestVerificationInput,
): Effect.Effect<boolean, SlackRequestVerificationError> =>
  Effect.tryPromise({
    try: async () => {
      const timestamp = Number.parseInt(input.timestamp, 10);
      const now = input.now?.() ?? Math.floor(Date.now() / 1_000);
      if (
        !Number.isSafeInteger(timestamp) ||
        Math.abs(now - timestamp) > (input.toleranceSeconds ?? 300)
      ) {
        return false;
      }
      if (!input.signature.startsWith("v0=")) return false;
      const signature = bytesFromHex(input.signature.slice(3));
      if (signature === undefined) return false;
      const encoder = new TextEncoder();
      const key = await globalThis.crypto.subtle.importKey(
        "raw",
        encoder.encode(input.signingSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      return globalThis.crypto.subtle.verify(
        "HMAC",
        key,
        signature,
        encoder.encode(`v0:${input.timestamp}:${input.rawBody}`),
      );
    },
    catch: (cause) =>
      new SlackRequestVerificationError({
        message: "Unable to verify Slack request",
        cause,
      }),
  });

export interface SlackHttpRequestOptions {
  readonly signingSecret: string;
  readonly now?: () => number;
  readonly toleranceSeconds?: number;
}

export type SlackHttpRequestResult =
  | { readonly kind: "challenge"; readonly challenge: string }
  | { readonly kind: "input"; readonly input: JsonValue };

const parseSlackHttpBody = (rawBody: string, contentType: string): unknown => {
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const parameters = new URLSearchParams(rawBody);
    const interactivePayload = parameters.get("payload");
    if (interactivePayload !== null) return JSON.parse(interactivePayload);
    return { type: "slash_command", ...Object.fromEntries(parameters) };
  }
  return JSON.parse(rawBody);
};

const withoutSlackCredentials = (value: JsonValue): JsonValue => {
  const snapshot = structuredClone(value);
  if (
    typeof snapshot === "object" &&
    snapshot !== null &&
    !Array.isArray(snapshot)
  ) {
    delete (snapshot as Record<string, JsonValue>).response_url;
    delete (snapshot as Record<string, JsonValue>).response_urls;
    delete (snapshot as Record<string, JsonValue>).token;
  }
  return snapshot;
};

export const decodeSlackHttpRequest = (
  request: Request,
  options: SlackHttpRequestOptions,
): Effect.Effect<SlackHttpRequestResult, SlackHttpIngressError> =>
  Effect.gen(function* () {
    const rawBody = yield* Effect.tryPromise({
      try: () => request.text(),
      catch: (cause) =>
        new SlackHttpIngressError({
          message: "Unable to read Slack request body",
          status: 400,
          cause,
        }),
    });
    const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
    const signature = request.headers.get("x-slack-signature") ?? "";
    const verified = yield* verifySlackRequest({
      signingSecret: options.signingSecret,
      rawBody,
      timestamp,
      signature,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.toleranceSeconds === undefined
        ? {}
        : { toleranceSeconds: options.toleranceSeconds }),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SlackHttpIngressError({
            message: "Unable to verify Slack request",
            status: 401,
            cause,
          }),
      ),
    );
    if (!verified) {
      return yield* new SlackHttpIngressError({
        message: "Slack request signature is invalid or expired",
        status: 401,
      });
    }
    const parsed = yield* Effect.try({
      try: () =>
        parseSlackHttpBody(
          rawBody,
          request.headers.get("content-type") ?? "application/json",
        ),
      catch: (cause) =>
        new SlackHttpIngressError({
          message: "Slack request body is malformed",
          status: 400,
          cause,
        }),
    });
    if (!isRecord(parsed) || !Schema.is(JsonValueSchema)(parsed)) {
      return yield* new SlackHttpIngressError({
        message: "Slack request body must be a portable JSON object",
        status: 400,
      });
    }
    if (parsed.type === "url_verification") {
      if (typeof parsed.challenge !== "string") {
        return yield* new SlackHttpIngressError({
          message: "Slack URL verification is missing its challenge",
          status: 400,
        });
      }
      return { kind: "challenge", challenge: parsed.challenge };
    }
    return { kind: "input", input: withoutSlackCredentials(parsed) };
  });

export interface SlackIntegrationOptions {
  readonly botToken: string;
  readonly botUserId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => string;
}

export interface SlackIntegration {
  readonly integration: WorkIntegration;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const slackTimestamp = (value: string): string => {
  const milliseconds = Number.parseFloat(value) * 1_000;
  if (!Number.isFinite(milliseconds))
    throw new Error("Invalid Slack timestamp");
  return new Date(milliseconds).toISOString();
};

const promptFrom = (text: string, botUserId: string): string =>
  text
    .replace(new RegExp(`<@${botUserId}(?:\\|[^>]+)?>`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();

export const makeSlackIntegration = (
  options: SlackIntegrationOptions,
): SlackIntegration => {
  const clock = options.clock ?? (() => new Date().toISOString());
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  const ingest: WorkIntegration["ingest"] = (input) =>
    Effect.try({
      try: (): readonly WorkEvent[] => {
        if (isRecord(input) && input.type === "slash_command") {
          if (
            typeof input.team_id !== "string" ||
            typeof input.channel_id !== "string" ||
            typeof input.user_id !== "string" ||
            typeof input.command !== "string" ||
            typeof input.text !== "string" ||
            typeof input.trigger_id !== "string" ||
            !Schema.is(JsonValueSchema)(input)
          ) {
            throw new Error("Malformed Slack slash command");
          }
          const receivedAt = clock();
          const id = `slack:command:${input.trigger_id}`;
          return [
            {
              schemaVersion: "0.1",
              id,
              type: "slack.command.invoked",
              occurredAt: receivedAt,
              receivedAt,
              idempotencyKey: id,
              source: {
                provider: "slack",
                authority: input.team_id,
                conversationId: input.channel_id,
                threadId: `command:${input.trigger_id}`,
              },
              payload: {
                activation: "command",
                surface: input.channel_id.startsWith("D") ? "dm" : "channel",
                teamId: input.team_id,
                channelId: input.channel_id,
                userId: input.user_id,
                command: input.command,
                prompt: input.text.trim(),
                triggerId: input.trigger_id,
              },
              raw: withoutSlackCredentials(input),
            },
          ];
        }
        if (isRecord(input) && input.type === "view_submission") {
          const team = input.team;
          const user = input.user;
          const view = input.view;
          if (
            !isRecord(team) ||
            typeof team.id !== "string" ||
            !isRecord(user) ||
            typeof user.id !== "string" ||
            typeof input.trigger_id !== "string" ||
            !isRecord(view) ||
            typeof view.id !== "string" ||
            typeof view.hash !== "string" ||
            typeof view.callback_id !== "string" ||
            !isRecord(view.state) ||
            !isRecord(view.state.values) ||
            !Schema.is(JsonValueSchema)(input)
          ) {
            throw new Error("Malformed Slack view submission");
          }
          const receivedAt = clock();
          const id = `slack:view:${view.id}:${view.hash}`;
          return [
            {
              schemaVersion: "0.1",
              id,
              type: "slack.form.submitted",
              occurredAt: receivedAt,
              receivedAt,
              idempotencyKey: id,
              source: {
                provider: "slack",
                authority: team.id,
                threadId: `view:${view.id}`,
              },
              payload: {
                activation: "form",
                surface: "modal",
                teamId: team.id,
                userId: user.id,
                triggerId: input.trigger_id,
                viewId: view.id,
                callbackId: view.callback_id,
                privateMetadata:
                  typeof view.private_metadata === "string"
                    ? view.private_metadata
                    : "",
                state: structuredClone(view.state.values) as JsonValue,
              },
              raw: withoutSlackCredentials(input),
            },
          ];
        }
        if (
          !isRecord(input) ||
          input.type !== "event_callback" ||
          typeof input.team_id !== "string" ||
          typeof input.event_id !== "string" ||
          !isRecord(input.event)
        ) {
          return [];
        }
        const event = input.event;
        if (event.type === "message" && event.subtype !== undefined) {
          return [];
        }
        if (
          typeof event.bot_id === "string" ||
          event.subtype === "bot_message" ||
          event.user === options.botUserId
        ) {
          return [];
        }
        const isMention = event.type === "app_mention";
        const isDirectMessage =
          event.type === "message" && event.channel_type === "im";
        const isThreadMessage =
          event.type === "message" && typeof event.thread_ts === "string";
        if (!isMention && !isDirectMessage && !isThreadMessage) return [];
        if (
          typeof event.user !== "string" ||
          typeof event.text !== "string" ||
          typeof event.ts !== "string" ||
          typeof event.channel !== "string"
        ) {
          throw new Error("Malformed Slack app_mention event");
        }
        if (!Schema.is(JsonValueSchema)(input)) {
          throw new Error("Slack event must be portable JSON data");
        }
        const threadTs =
          typeof event.thread_ts === "string" ? event.thread_ts : event.ts;
        const id = `slack:${input.event_id}`;
        const surface = isDirectMessage ? "dm" : "channel";
        const activation = isMention
          ? "mention"
          : isDirectMessage
            ? "direct"
            : "thread";
        return [
          {
            schemaVersion: "0.1",
            id,
            type: isMention
              ? "slack.message.mentioned"
              : "slack.message.received",
            occurredAt: slackTimestamp(event.ts),
            receivedAt: clock(),
            idempotencyKey: id,
            source: {
              provider: "slack",
              authority: input.team_id,
              conversationId: event.channel,
              threadId: threadTs,
              messageId: event.ts,
            },
            payload: {
              activation,
              surface,
              teamId: input.team_id,
              channelId: event.channel,
              threadTs,
              messageTs: event.ts,
              userId: event.user,
              text: event.text,
              prompt: promptFrom(event.text, options.botUserId),
            },
            raw: withoutSlackCredentials(input),
          },
        ];
      },
      catch: (cause) =>
        new IntegrationError({
          message: "Invalid Slack event",
          retryable: false,
          cause,
        }),
    });

  const apiCall = (
    method: string,
    body: Record<string, unknown>,
    acceptedErrors: readonly string[] = [],
  ) =>
    Effect.tryPromise({
      try: () =>
        fetchImplementation(`https://slack.com/api/${method}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.botToken}`,
            "content-type": "application/json; charset=utf-8",
          },
          body: JSON.stringify(body),
        }),
      catch: (cause) =>
        new IntegrationError({
          message: `Slack ${method} request failed`,
          retryable: true,
          cause,
        }),
    }).pipe(
      Effect.flatMap((response) =>
        Effect.tryPromise({
          try: () => response.json() as Promise<unknown>,
          catch: (cause) =>
            new IntegrationError({
              message: `Slack ${method} returned invalid JSON`,
              retryable: response.status >= 500,
              cause,
            }),
        }).pipe(Effect.map((payload) => ({ payload, response }))),
      ),
      Effect.flatMap(({ payload, response }) => {
        if (!isRecord(payload) || !Schema.is(JsonValueSchema)(payload)) {
          return Effect.fail(
            new IntegrationError({
              message: `Slack ${method} returned an invalid response`,
              retryable: response.status >= 500,
            }),
          );
        }
        if (!response.ok || payload.ok !== true) {
          const code =
            typeof payload.error === "string" ? payload.error : "unknown";
          if (response.ok && acceptedErrors.includes(code)) {
            return Effect.succeed({ providerReceipt: payload });
          }
          return Effect.fail(
            new IntegrationError({
              message: `Slack ${method} failed: ${code}`,
              retryable:
                response.status === 429 ||
                response.status >= 500 ||
                code === "ratelimited" ||
                code === "internal_error",
              cause: payload,
            }),
          );
        }
        return Effect.succeed({ providerReceipt: payload });
      }),
    );

  const deliver: WorkIntegration["deliver"] = (effect) => {
    if (!isRecord(effect.input)) {
      return Effect.fail(
        new IntegrationError({
          message: `Slack ${effect.operation} input must be an object`,
          retryable: false,
        }),
      );
    }
    if (effect.operation === "view.open") {
      const { triggerId, view } = effect.input;
      if (
        typeof triggerId !== "string" ||
        !isRecord(view) ||
        !Schema.is(JsonValueSchema)(view)
      ) {
        return Effect.fail(
          new IntegrationError({
            message: "Slack view.open requires triggerId and a portable view",
            retryable: false,
          }),
        );
      }
      return apiCall("views.open", { trigger_id: triggerId, view });
    }
    if (effect.operation === "message.react") {
      const { channelId, messageTs, emoji } = effect.input;
      if (
        typeof channelId !== "string" ||
        typeof messageTs !== "string" ||
        typeof emoji !== "string"
      ) {
        return Effect.fail(
          new IntegrationError({
            message:
              "Slack message.react requires channelId, messageTs, and emoji",
            retryable: false,
          }),
        );
      }
      return apiCall(
        "reactions.add",
        {
          channel: channelId,
          timestamp: messageTs,
          name: emoji,
        },
        ["already_reacted"],
      );
    }
    if (effect.operation === "message.post") {
      const { channelId, text } = effect.input;
      if (typeof channelId !== "string" || typeof text !== "string") {
        return Effect.fail(
          new IntegrationError({
            message: "Slack message.post requires channelId and text",
            retryable: false,
          }),
        );
      }
      return apiCall("chat.postMessage", { channel: channelId, text });
    }
    if (effect.operation === "message.ephemeral") {
      const { channelId, userId, text } = effect.input;
      if (
        typeof channelId !== "string" ||
        typeof userId !== "string" ||
        typeof text !== "string"
      ) {
        return Effect.fail(
          new IntegrationError({
            message:
              "Slack message.ephemeral requires channelId, userId, and text",
            retryable: false,
          }),
        );
      }
      return apiCall("chat.postEphemeral", {
        channel: channelId,
        user: userId,
        text,
      });
    }
    if (effect.operation !== "message.reply") {
      return Effect.fail(
        new IntegrationError({
          message: `Unsupported Slack operation: ${effect.operation}`,
          retryable: false,
        }),
      );
    }
    const { channelId, threadTs, text } = effect.input;
    if (
      typeof channelId !== "string" ||
      typeof threadTs !== "string" ||
      typeof text !== "string"
    ) {
      return Effect.fail(
        new IntegrationError({
          message: "Slack message.reply requires channelId, threadTs, and text",
          retryable: false,
        }),
      );
    }
    return apiCall("chat.postMessage", {
      channel: channelId,
      thread_ts: threadTs,
      text,
    });
  };

  return {
    integration: {
      manifest: {
        id: "slack",
        displayName: "Slack",
        events: [
          "slack.message.mentioned",
          "slack.message.received",
          "slack.command.invoked",
          "slack.form.submitted",
        ],
        operations: [
          "message.reply",
          "message.post",
          "message.ephemeral",
          "message.react",
          "view.open",
        ],
      },
      ingest,
      deliver,
    },
  };
};

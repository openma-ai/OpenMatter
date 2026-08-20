import {
  JsonValueSchema,
  type JsonValue,
  type WorkEvent,
} from "@openmatter/core";
import { IntegrationError } from "@openmatter/integration";
import { Effect, Schema } from "effect";
import {
  isRecord,
  promptFrom,
  slackOccurredAt,
  slackSource,
  slackTimestamp,
  withoutSlackCredentials,
} from "./shared.js";

export const normalizeSlackEvents = (
  input: unknown,
  botUserId: string,
  authority: string | undefined,
  clock: () => string,
) =>
  Effect.try({
    try: (): readonly WorkEvent[] => {
      if (isRecord(input) && input.type === "slash_command") {
        if (
          authority === undefined ||
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
              authority,
              conversationId: input.channel_id,
              threadId: `command:${input.trigger_id}`,
            },
            payload: {
              activation: "command",
              surface: input.channel_id.startsWith("D") ? "dm" : "channel",
              teamId: authority,
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
      if (isRecord(input) && input.type === "block_actions") {
        const user = input.user;
        const container = input.container;
        const firstAction = Array.isArray(input.actions)
          ? input.actions[0]
          : undefined;
        if (
          authority === undefined ||
          !isRecord(user) ||
          typeof user.id !== "string" ||
          typeof input.trigger_id !== "string" ||
          !Array.isArray(input.actions) ||
          !isRecord(firstAction) ||
          typeof firstAction.action_ts !== "string" ||
          !Schema.is(JsonValueSchema)(input)
        ) {
          throw new Error("Malformed Slack block action");
        }
        const actionTs = firstAction.action_ts;
        const channelId =
          isRecord(container) && typeof container.channel_id === "string"
            ? container.channel_id
            : undefined;
        const messageTs =
          isRecord(container) && typeof container.message_ts === "string"
            ? container.message_ts
            : undefined;
        const threadTs =
          isRecord(container) && typeof container.thread_ts === "string"
            ? container.thread_ts
            : messageTs;
        const receivedAt = clock();
        const id = `slack:action:${input.trigger_id}:${actionTs}`;
        return [
          {
            schemaVersion: "0.1",
            id,
            type: "slack.action.invoked",
            occurredAt: slackTimestamp(actionTs),
            receivedAt,
            idempotencyKey: id,
            source: slackSource(authority, {
              ...(channelId === undefined ? {} : { channelId }),
              ...(threadTs === undefined ? {} : { threadTs }),
              ...(messageTs === undefined ? {} : { messageTs }),
            }),
            payload: {
              activation: "action",
              surface:
                channelId === undefined
                  ? "modal"
                  : channelId.startsWith("D")
                    ? "dm"
                    : "channel",
              teamId: authority,
              ...(channelId === undefined ? {} : { channelId }),
              ...(threadTs === undefined ? {} : { threadTs }),
              ...(messageTs === undefined ? {} : { messageTs }),
              userId: user.id,
              triggerId: input.trigger_id,
              actions: structuredClone(input.actions) as JsonValue,
            },
            raw: withoutSlackCredentials(input),
          },
        ];
      }
      if (
        isRecord(input) &&
        (input.type === "shortcut" || input.type === "message_action")
      ) {
        const user = input.user;
        const channel = input.channel;
        const message = input.message;
        if (
          authority === undefined ||
          !isRecord(user) ||
          typeof user.id !== "string" ||
          typeof input.callback_id !== "string" ||
          typeof input.trigger_id !== "string" ||
          (input.action_ts !== undefined &&
            typeof input.action_ts !== "string") ||
          !Schema.is(JsonValueSchema)(input)
        ) {
          throw new Error("Malformed Slack shortcut");
        }
        const channelId =
          isRecord(channel) && typeof channel.id === "string"
            ? channel.id
            : undefined;
        const messageTs =
          isRecord(message) && typeof message.ts === "string"
            ? message.ts
            : undefined;
        const threadTs =
          isRecord(message) && typeof message.thread_ts === "string"
            ? message.thread_ts
            : messageTs;
        const receivedAt = clock();
        const id = `slack:shortcut:${input.trigger_id}`;
        return [
          {
            schemaVersion: "0.1",
            id,
            type: "slack.shortcut.invoked",
            occurredAt:
              typeof input.action_ts === "string"
                ? slackTimestamp(input.action_ts)
                : receivedAt,
            receivedAt,
            idempotencyKey: id,
            source: slackSource(authority, {
              ...(channelId === undefined ? {} : { channelId }),
              ...(threadTs === undefined ? {} : { threadTs }),
              ...(messageTs === undefined ? {} : { messageTs }),
            }),
            payload: {
              activation: "shortcut",
              surface:
                channelId === undefined
                  ? "global"
                  : channelId.startsWith("D")
                    ? "dm"
                    : "channel",
              teamId: authority,
              ...(channelId === undefined ? {} : { channelId }),
              ...(threadTs === undefined ? {} : { threadTs }),
              ...(messageTs === undefined ? {} : { messageTs }),
              userId: user.id,
              callbackId: input.callback_id,
              triggerId: input.trigger_id,
              ...(isRecord(message)
                ? { message: structuredClone(message) as JsonValue }
                : {}),
            },
            raw: withoutSlackCredentials(input),
          },
        ];
      }
      if (isRecord(input) && input.type === "view_submission") {
        const user = input.user;
        const view = input.view;
        if (
          authority === undefined ||
          !isRecord(user) ||
          typeof user.id !== "string" ||
          (input.trigger_id !== undefined &&
            typeof input.trigger_id !== "string") ||
          !isRecord(view) ||
          typeof view.id !== "string" ||
          (view.hash !== undefined && typeof view.hash !== "string") ||
          (view.callback_id !== undefined &&
            typeof view.callback_id !== "string") ||
          !Schema.is(JsonValueSchema)(input)
        ) {
          throw new Error("Malformed Slack view submission");
        }
        const receivedAt = clock();
        const id = `slack:view:${view.id}:${typeof view.hash === "string" ? view.hash : "submitted"}`;
        const state =
          isRecord(view.state) && isRecord(view.state.values)
            ? view.state.values
            : {};
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
              authority,
              threadId: `view:${view.id}`,
            },
            payload: {
              activation: "form",
              surface: "modal",
              teamId: authority,
              userId: user.id,
              ...(typeof input.trigger_id === "string"
                ? { triggerId: input.trigger_id }
                : {}),
              viewId: view.id,
              ...(typeof view.callback_id === "string"
                ? { callbackId: view.callback_id }
                : {}),
              privateMetadata:
                typeof view.private_metadata === "string"
                  ? view.private_metadata
                  : "",
              state: structuredClone(state) as JsonValue,
            },
            raw: withoutSlackCredentials(input),
          },
        ];
      }
      if (isRecord(input) && input.type === "view_closed") {
        const user = input.user;
        const view = input.view;
        if (
          authority === undefined ||
          !isRecord(user) ||
          typeof user.id !== "string" ||
          !isRecord(view) ||
          typeof view.id !== "string" ||
          (view.hash !== undefined && typeof view.hash !== "string") ||
          (view.callback_id !== undefined &&
            typeof view.callback_id !== "string") ||
          !Schema.is(JsonValueSchema)(input)
        ) {
          throw new Error("Malformed Slack view closed interaction");
        }
        const receivedAt = clock();
        const id =
          typeof view.hash === "string"
            ? `slack:view:${view.id}:${view.hash}:closed`
            : `slack:view:${view.id}:closed`;
        return [
          {
            schemaVersion: "0.1",
            id,
            type: "slack.form.closed",
            occurredAt: receivedAt,
            receivedAt,
            idempotencyKey: id,
            source: slackSource(authority, { threadTs: `view:${view.id}` }),
            payload: {
              activation: "observation",
              surface: "modal",
              teamId: authority,
              userId: user.id,
              viewId: view.id,
              ...(typeof view.callback_id === "string"
                ? { callbackId: view.callback_id }
                : {}),
              isCleared: input.is_cleared === true,
              privateMetadata:
                typeof view.private_metadata === "string"
                  ? view.private_metadata
                  : "",
            },
            raw: withoutSlackCredentials(input),
          },
        ];
      }
      if (
        !isRecord(input) ||
        input.type !== "event_callback" ||
        authority === undefined ||
        typeof input.event_id !== "string" ||
        !isRecord(input.event)
      ) {
        return [];
      }
      const event = input.event;
      if (!Schema.is(JsonValueSchema)(input)) {
        throw new Error("Slack event must be portable JSON data");
      }
      if (
        event.type === "message" &&
        (typeof event.bot_id === "string" ||
          event.subtype === "bot_message" ||
          event.user === botUserId)
      ) {
        const receivedAt = clock();
        const id = `slack:${input.event_id}`;
        return [
          {
            schemaVersion: "0.1",
            id,
            type: "slack.event.received",
            occurredAt: slackOccurredAt(input, event, receivedAt),
            receivedAt,
            idempotencyKey: id,
            source: slackSource(authority, {
              ...(typeof event.channel === "string"
                ? { channelId: event.channel }
                : {}),
            }),
            payload: {
              activation: "observation",
              teamId: authority,
              eventType:
                typeof event.subtype === "string"
                  ? `message.${event.subtype}`
                  : "message.bot",
              event: structuredClone(event) as JsonValue,
            },
            raw: withoutSlackCredentials(input),
          },
        ];
      }
      if (event.type === "message" && event.subtype === "message_changed") {
        const message = event.message;
        const previous = event.previous_message;
        if (
          typeof event.channel !== "string" ||
          !isRecord(message) ||
          typeof message.user !== "string" ||
          typeof message.text !== "string" ||
          typeof message.ts !== "string" ||
          !Schema.is(JsonValueSchema)(input)
        ) {
          throw new Error("Malformed Slack message_changed event");
        }
        const threadTs =
          typeof message.thread_ts === "string"
            ? message.thread_ts
            : message.ts;
        const receivedAt = clock();
        const id = `slack:${input.event_id}`;
        return [
          {
            schemaVersion: "0.1",
            id,
            type: "slack.message.updated",
            occurredAt: slackOccurredAt(input, event, receivedAt),
            receivedAt,
            idempotencyKey: id,
            source: slackSource(authority, {
              channelId: event.channel,
              threadTs,
              messageTs: message.ts,
            }),
            payload: {
              activation: "observation",
              surface:
                event.channel_type === "im" || event.channel.startsWith("D")
                  ? "dm"
                  : "channel",
              teamId: authority,
              channelId: event.channel,
              threadTs,
              messageTs: message.ts,
              userId: message.user,
              text: message.text,
              ...(isRecord(previous) && typeof previous.text === "string"
                ? { previousText: previous.text }
                : {}),
            },
            raw: withoutSlackCredentials(input),
          },
        ];
      }
      if (event.type === "message" && event.subtype === "message_deleted") {
        const previous = event.previous_message;
        if (
          typeof event.channel !== "string" ||
          typeof event.deleted_ts !== "string" ||
          !isRecord(previous) ||
          !Schema.is(JsonValueSchema)(input)
        ) {
          throw new Error("Malformed Slack message_deleted event");
        }
        const threadTs =
          typeof previous.thread_ts === "string"
            ? previous.thread_ts
            : event.deleted_ts;
        const receivedAt = clock();
        const id = `slack:${input.event_id}`;
        return [
          {
            schemaVersion: "0.1",
            id,
            type: "slack.message.deleted",
            occurredAt: slackOccurredAt(input, event, receivedAt),
            receivedAt,
            idempotencyKey: id,
            source: slackSource(authority, {
              channelId: event.channel,
              threadTs,
              messageTs: event.deleted_ts,
            }),
            payload: {
              activation: "observation",
              surface: event.channel.startsWith("D") ? "dm" : "channel",
              teamId: authority,
              channelId: event.channel,
              threadTs,
              messageTs: event.deleted_ts,
              previousMessage: structuredClone(previous) as JsonValue,
            },
            raw: withoutSlackCredentials(input),
          },
        ];
      }
      if (
        event.type === "reaction_added" ||
        event.type === "reaction_removed"
      ) {
        const item = event.item;
        if (
          typeof event.user !== "string" ||
          typeof event.reaction !== "string" ||
          !isRecord(item) ||
          item.type !== "message" ||
          typeof item.channel !== "string" ||
          typeof item.ts !== "string" ||
          !Schema.is(JsonValueSchema)(input)
        ) {
          throw new Error("Malformed Slack reaction event");
        }
        const receivedAt = clock();
        const id = `slack:${input.event_id}`;
        return [
          {
            schemaVersion: "0.1",
            id,
            type:
              event.type === "reaction_added"
                ? "slack.reaction.added"
                : "slack.reaction.removed",
            occurredAt: slackOccurredAt(input, event, receivedAt),
            receivedAt,
            idempotencyKey: id,
            source: slackSource(authority, {
              channelId: item.channel,
              threadTs: item.ts,
              messageTs: item.ts,
            }),
            payload: {
              activation: "observation",
              teamId: authority,
              channelId: item.channel,
              messageTs: item.ts,
              userId: event.user,
              ...(typeof event.item_user === "string"
                ? { itemUserId: event.item_user }
                : {}),
              emoji: event.reaction,
            },
            raw: withoutSlackCredentials(input),
          },
        ];
      }
      if (event.type === "message" && event.subtype !== undefined) {
        const receivedAt = clock();
        const id = `slack:${input.event_id}`;
        return [
          {
            schemaVersion: "0.1",
            id,
            type: "slack.event.received",
            occurredAt: slackOccurredAt(input, event, receivedAt),
            receivedAt,
            idempotencyKey: id,
            source: slackSource(authority, {
              ...(typeof event.channel === "string"
                ? { channelId: event.channel }
                : {}),
            }),
            payload: {
              activation: "observation",
              teamId: authority,
              eventType:
                typeof event.subtype === "string"
                  ? `message.${event.subtype}`
                  : "message",
              event: structuredClone(event) as JsonValue,
            },
            raw: withoutSlackCredentials(input),
          },
        ];
      }
      const isMention = event.type === "app_mention";
      const isDirectMessage =
        event.type === "message" && event.channel_type === "im";
      const isThreadMessage =
        event.type === "message" && typeof event.thread_ts === "string";
      const isChannelMessage =
        event.type === "message" && event.subtype === undefined;
      if (
        !isMention &&
        !isDirectMessage &&
        !isThreadMessage &&
        !isChannelMessage
      ) {
        if (typeof event.type !== "string") return [];
        if (!Schema.is(JsonValueSchema)(input)) {
          throw new Error("Slack event must be portable JSON data");
        }
        const receivedAt = clock();
        const id = `slack:${input.event_id}`;
        return [
          {
            schemaVersion: "0.1",
            id,
            type: "slack.event.received",
            occurredAt: slackOccurredAt(input, event, receivedAt),
            receivedAt,
            idempotencyKey: id,
            source: slackSource(authority, {
              ...(typeof event.channel === "string"
                ? { channelId: event.channel }
                : {}),
            }),
            payload: {
              activation: "observation",
              teamId: authority,
              eventType: event.type,
              event: structuredClone(event) as JsonValue,
            },
            raw: withoutSlackCredentials(input),
          },
        ];
      }
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
          : isThreadMessage
            ? "thread"
            : "observation";
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
            authority,
            conversationId: event.channel,
            threadId: threadTs,
            messageId: event.ts,
          },
          payload: {
            activation,
            surface,
            teamId: authority,
            channelId: event.channel,
            threadTs,
            messageTs: event.ts,
            userId: event.user,
            text: event.text,
            prompt: promptFrom(event.text, botUserId),
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

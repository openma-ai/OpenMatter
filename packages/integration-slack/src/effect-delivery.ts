import { JsonValueSchema } from "@openmatter/core";
import type { WorkIntegration } from "@openmatter/integration";
import { IntegrationError } from "@openmatter/integration";
import { Effect, Schema } from "effect";
import type { SlackProviderClient } from "./provider-client.js";
import { isRecord } from "./shared.js";

export const makeSlackEffectDelivery = (input: {
  readonly apiCall: SlackProviderClient["apiCall"];
  readonly fetchImplementation: typeof globalThis.fetch;
  readonly retryAtFrom: SlackProviderClient["retryAtFrom"];
}): WorkIntegration["deliver"] => {
  const { apiCall, fetchImplementation, retryAtFrom } = input;

  const deliver: WorkIntegration["deliver"] = (effect) => {
    if (!isRecord(effect.input)) {
      return Effect.fail(
        new IntegrationError({
          message: `Slack ${effect.operation} input must be an object`,
          retryable: false,
        }),
      );
    }
    const blocks = effect.input.blocks;
    if (
      blocks !== undefined &&
      (!Array.isArray(blocks) || !Schema.is(JsonValueSchema)(blocks))
    ) {
      return Effect.fail(
        new IntegrationError({
          message: `Slack ${effect.operation} blocks must be portable JSON`,
          retryable: false,
        }),
      );
    }
    const teamId =
      typeof effect.input.teamId === "string" ? effect.input.teamId : undefined;
    const clientContextTeamId = effect.input.clientContextTeamId;
    if (
      clientContextTeamId !== undefined &&
      typeof clientContextTeamId !== "string"
    ) {
      return Effect.fail(
        new IntegrationError({
          message: `Slack ${effect.operation} clientContextTeamId must be a string`,
          retryable: false,
        }),
      );
    }
    const call = (
      method: string,
      body: Record<string, unknown>,
      acceptedErrors: readonly string[] = [],
    ) => apiCall(method, body, acceptedErrors, teamId);
    const callWithChannelContext = (
      method: string,
      body: Record<string, unknown>,
      acceptedErrors: readonly string[] = [],
    ) =>
      call(
        method,
        {
          ...body,
          ...(clientContextTeamId === undefined
            ? {}
            : { client_context_team_id: clientContextTeamId }),
        },
        acceptedErrors,
      );
    if (effect.operation === "file.upload") {
      const { filename, content, title, channelId, threadTs, initialComment } =
        effect.input;
      if (
        typeof filename !== "string" ||
        filename.length === 0 ||
        typeof content !== "string" ||
        content.length === 0 ||
        (title !== undefined && typeof title !== "string") ||
        (channelId !== undefined && typeof channelId !== "string") ||
        (threadTs !== undefined && typeof threadTs !== "string") ||
        (initialComment !== undefined && typeof initialComment !== "string")
      ) {
        return Effect.fail(
          new IntegrationError({
            message:
              "Slack file.upload requires filename, non-empty text content, and valid optional destination fields",
            retryable: false,
          }),
        );
      }
      const bytes = new TextEncoder().encode(content);
      return Effect.gen(function* () {
        const ticket = yield* call("files.getUploadURLExternal", {
          filename,
          length: bytes.byteLength,
        });
        const receipt = ticket.providerReceipt;
        if (
          !isRecord(receipt) ||
          typeof receipt.upload_url !== "string" ||
          typeof receipt.file_id !== "string"
        ) {
          return yield* new IntegrationError({
            message:
              "Slack files.getUploadURLExternal response is missing upload_url or file_id",
            retryable: false,
          });
        }
        const uploadUrl = receipt.upload_url;
        const fileId = receipt.file_id;
        const uploaded = yield* Effect.tryPromise({
          try: () =>
            fetchImplementation(uploadUrl, {
              method: "POST",
              headers: { "content-type": "application/octet-stream" },
              body: bytes,
            }),
          catch: (cause) =>
            new IntegrationError({
              message: "Slack external file upload failed",
              retryable: true,
              cause,
            }),
        });
        if (!uploaded.ok) {
          const retryAt = retryAtFrom(uploaded);
          return yield* new IntegrationError({
            message: `Slack external file upload failed with HTTP ${uploaded.status}`,
            retryable: uploaded.status === 429 || uploaded.status >= 500,
            ...(retryAt === undefined ? {} : { retryAt }),
          });
        }
        return yield* callWithChannelContext("files.completeUploadExternal", {
          files: [{ id: fileId, title: title ?? filename }],
          ...(channelId === undefined ? {} : { channel_id: channelId }),
          ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
          ...(initialComment === undefined
            ? {}
            : { initial_comment: initialComment }),
        });
      });
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
      return call("views.open", { trigger_id: triggerId, view });
    }
    if (effect.operation === "view.update") {
      const { viewId, hash, view } = effect.input;
      if (
        typeof viewId !== "string" ||
        (hash !== undefined && typeof hash !== "string") ||
        !isRecord(view) ||
        !Schema.is(JsonValueSchema)(view)
      ) {
        return Effect.fail(
          new IntegrationError({
            message:
              "Slack view.update requires viewId, a portable view, and an optional hash",
            retryable: false,
          }),
        );
      }
      return call("views.update", {
        view_id: viewId,
        ...(hash === undefined ? {} : { hash }),
        view,
      });
    }
    if (effect.operation === "view.push") {
      const { triggerId, view } = effect.input;
      if (
        typeof triggerId !== "string" ||
        !isRecord(view) ||
        !Schema.is(JsonValueSchema)(view)
      ) {
        return Effect.fail(
          new IntegrationError({
            message: "Slack view.push requires triggerId and a portable view",
            retryable: false,
          }),
        );
      }
      return call("views.push", { trigger_id: triggerId, view });
    }
    if (effect.operation === "home.publish") {
      const { userId, view } = effect.input;
      if (
        typeof userId !== "string" ||
        !isRecord(view) ||
        !Schema.is(JsonValueSchema)(view)
      ) {
        return Effect.fail(
          new IntegrationError({
            message: "Slack home.publish requires userId and a portable view",
            retryable: false,
          }),
        );
      }
      return call("views.publish", { user_id: userId, view });
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
      return callWithChannelContext(
        "reactions.add",
        {
          channel: channelId,
          timestamp: messageTs,
          name: emoji,
        },
        ["already_reacted"],
      );
    }
    if (effect.operation === "message.unreact") {
      const { channelId, messageTs, emoji } = effect.input;
      if (
        typeof channelId !== "string" ||
        typeof messageTs !== "string" ||
        typeof emoji !== "string"
      ) {
        return Effect.fail(
          new IntegrationError({
            message:
              "Slack message.unreact requires channelId, messageTs, and emoji",
            retryable: false,
          }),
        );
      }
      return callWithChannelContext(
        "reactions.remove",
        { channel: channelId, timestamp: messageTs, name: emoji },
        ["no_reaction"],
      );
    }
    if (effect.operation === "message.update") {
      const { channelId, messageTs, text } = effect.input;
      if (
        typeof channelId !== "string" ||
        typeof messageTs !== "string" ||
        (text !== undefined && typeof text !== "string") ||
        (text === undefined && blocks === undefined)
      ) {
        return Effect.fail(
          new IntegrationError({
            message:
              "Slack message.update requires channelId, messageTs, and text or blocks",
            retryable: false,
          }),
        );
      }
      return callWithChannelContext("chat.update", {
        channel: channelId,
        ts: messageTs,
        ...(text === undefined ? {} : { text }),
        ...(blocks === undefined ? {} : { blocks }),
      });
    }
    if (effect.operation === "message.delete") {
      const { channelId, messageTs } = effect.input;
      if (typeof channelId !== "string" || typeof messageTs !== "string") {
        return Effect.fail(
          new IntegrationError({
            message: "Slack message.delete requires channelId and messageTs",
            retryable: false,
          }),
        );
      }
      return callWithChannelContext(
        "chat.delete",
        { channel: channelId, ts: messageTs },
        ["message_not_found"],
      );
    }
    if (effect.operation === "message.schedule") {
      const { channelId, postAt, text } = effect.input;
      if (
        typeof channelId !== "string" ||
        !Number.isSafeInteger(postAt) ||
        (text !== undefined && typeof text !== "string") ||
        (text === undefined && blocks === undefined)
      ) {
        return Effect.fail(
          new IntegrationError({
            message:
              "Slack message.schedule requires channelId, integer postAt, and text or blocks",
            retryable: false,
          }),
        );
      }
      return callWithChannelContext("chat.scheduleMessage", {
        channel: channelId,
        post_at: postAt,
        ...(text === undefined ? {} : { text }),
        ...(blocks === undefined ? {} : { blocks }),
      });
    }
    if (effect.operation === "message.schedule.cancel") {
      const { channelId, scheduledMessageId } = effect.input;
      if (
        typeof channelId !== "string" ||
        typeof scheduledMessageId !== "string"
      ) {
        return Effect.fail(
          new IntegrationError({
            message:
              "Slack message.schedule.cancel requires channelId and scheduledMessageId",
            retryable: false,
          }),
        );
      }
      return callWithChannelContext("chat.deleteScheduledMessage", {
        channel: channelId,
        scheduled_message_id: scheduledMessageId,
      });
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
      return callWithChannelContext("chat.postMessage", {
        channel: channelId,
        text,
        ...(blocks === undefined ? {} : { blocks }),
      });
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
      return callWithChannelContext("chat.postEphemeral", {
        channel: channelId,
        user: userId,
        text,
        ...(blocks === undefined ? {} : { blocks }),
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
    return callWithChannelContext("chat.postMessage", {
      channel: channelId,
      thread_ts: threadTs,
      text,
      ...(blocks === undefined ? {} : { blocks }),
    });
  };

  return deliver;
};

import type { ContextItem, JsonValue } from "@openmatter/core";
import { IntegrationError } from "@openmatter/integration";
import { Effect } from "effect";
import type { SlackProviderClient } from "./provider-client.js";
import { isRecord } from "./shared.js";
import type { SlackContextReader } from "./types.js";

export const makeSlackContextReader = (
  input: Pick<SlackProviderClient, "apiRead">,
): SlackContextReader => {
  const { apiRead } = input;

  const contextItem = (input: {
    readonly id: string;
    readonly kind: string;
    readonly value: JsonValue;
    readonly sourceId: string;
    readonly uri?: string;
  }): ContextItem => ({
    id: input.id,
    kind: input.kind,
    value: input.value,
    provenance: [
      {
        sourceType: "slack-api",
        sourceId: input.sourceId,
        integrationId: "slack",
        ...(input.uri === undefined ? {} : { uri: input.uri }),
      },
    ],
  });

  const page = (
    payload: Record<string, JsonValue>,
    method: string,
  ): Effect.Effect<
    {
      readonly messages: JsonValue;
      readonly hasMore: boolean;
      readonly nextCursor: string;
    },
    IntegrationError
  > => {
    if (!Array.isArray(payload.messages)) {
      return Effect.fail(
        new IntegrationError({
          message: `Slack ${method} response is missing messages`,
          retryable: false,
        }),
      );
    }
    const metadata = payload.response_metadata;
    const nextCursor =
      isRecord(metadata) && typeof metadata.next_cursor === "string"
        ? metadata.next_cursor
        : "";
    return Effect.succeed({
      messages: structuredClone(payload.messages) as JsonValue,
      hasMore: payload.has_more === true || nextCursor.length > 0,
      nextCursor,
    });
  };

  const context: SlackContextReader = {
    thread: (input) =>
      apiRead(
        "conversations.replies",
        {
          channel: input.channelId,
          ts: input.threadTs,
          limit: input.limit,
          cursor: input.cursor,
          client_context_team_id: input.contextTeamId,
        },
        input.teamId,
      ).pipe(
        Effect.flatMap((payload) => page(payload, "conversations.replies")),
        Effect.map((result) =>
          contextItem({
            id: `slack:${input.teamId}:thread:${input.channelId}:${input.threadTs}`,
            kind: "slack.thread",
            value: {
              teamId: input.teamId,
              ...(input.contextTeamId === undefined
                ? {}
                : { contextTeamId: input.contextTeamId }),
              channelId: input.channelId,
              threadTs: input.threadTs,
              messages: result.messages,
              hasMore: result.hasMore,
              nextCursor: result.nextCursor,
            },
            sourceId: `${input.teamId}:${input.channelId}:${input.threadTs}`,
            uri: `https://slack.com/archives/${input.channelId}/p${input.threadTs.replace(".", "")}`,
          }),
        ),
      ),
    history: (input) =>
      apiRead(
        "conversations.history",
        {
          channel: input.channelId,
          limit: input.limit,
          cursor: input.cursor,
          oldest: input.oldest,
          latest: input.latest,
          client_context_team_id: input.contextTeamId,
        },
        input.teamId,
      ).pipe(
        Effect.flatMap((payload) => page(payload, "conversations.history")),
        Effect.map((result) =>
          contextItem({
            id: `slack:${input.teamId}:history:${input.channelId}`,
            kind: "slack.channel-history",
            value: {
              teamId: input.teamId,
              ...(input.contextTeamId === undefined
                ? {}
                : { contextTeamId: input.contextTeamId }),
              channelId: input.channelId,
              messages: result.messages,
              hasMore: result.hasMore,
              nextCursor: result.nextCursor,
            },
            sourceId: `${input.teamId}:${input.channelId}:history`,
          }),
        ),
      ),
    conversation: (input) =>
      apiRead(
        "conversations.info",
        {
          channel: input.channelId,
          client_context_team_id: input.contextTeamId,
        },
        input.teamId,
      ).pipe(
        Effect.flatMap((payload) =>
          isRecord(payload.channel)
            ? Effect.succeed(payload.channel as JsonValue)
            : Effect.fail(
                new IntegrationError({
                  message:
                    "Slack conversations.info response is missing channel",
                  retryable: false,
                }),
              ),
        ),
        Effect.map((channel) =>
          contextItem({
            id: `slack:${input.teamId}:conversation:${input.channelId}`,
            kind: "slack.conversation",
            value: {
              teamId: input.teamId,
              ...(input.contextTeamId === undefined
                ? {}
                : { contextTeamId: input.contextTeamId }),
              channel,
            },
            sourceId: `${input.teamId}:${input.channelId}`,
          }),
        ),
      ),
    user: (input) =>
      apiRead("users.info", { user: input.userId }, input.teamId).pipe(
        Effect.flatMap((payload) =>
          isRecord(payload.user)
            ? Effect.succeed(payload.user as JsonValue)
            : Effect.fail(
                new IntegrationError({
                  message: "Slack users.info response is missing user",
                  retryable: false,
                }),
              ),
        ),
        Effect.map((user) =>
          contextItem({
            id: `slack:${input.teamId}:user:${input.userId}`,
            kind: "slack.user",
            value: { teamId: input.teamId, user },
            sourceId: `${input.teamId}:${input.userId}`,
          }),
        ),
      ),
    file: (input) =>
      apiRead("files.info", { file: input.fileId }, input.teamId).pipe(
        Effect.flatMap((payload) =>
          isRecord(payload.file)
            ? Effect.succeed(payload.file as JsonValue)
            : Effect.fail(
                new IntegrationError({
                  message: "Slack files.info response is missing file",
                  retryable: false,
                }),
              ),
        ),
        Effect.map((file) =>
          contextItem({
            id: `slack:${input.teamId}:file:${input.fileId}`,
            kind: "slack.file",
            value: { teamId: input.teamId, file },
            sourceId: `${input.teamId}:${input.fileId}`,
          }),
        ),
      ),
  };

  return context;
};

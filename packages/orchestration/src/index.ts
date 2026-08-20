import type { ContextItem } from "@openmatter/core";
import type { OpenMatterApplication, WorkContext } from "@openmatter/runtime";
import { Effect } from "effect";

export interface ClaudeTagOptions {
  readonly agentId: string;
  readonly commandVisibility?: "ephemeral" | "channel";
  readonly context?: (
    work: WorkContext,
  ) =>
    | readonly ContextItem[]
    | Promise<readonly ContextItem[]>
    | Effect.Effect<readonly ContextItem[], unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const outputText = (output: unknown): string =>
  typeof output === "string" ? output : JSON.stringify(output ?? null);

const loadContext = (
  loader: NonNullable<ClaudeTagOptions["context"]>,
  work: WorkContext,
): Effect.Effect<readonly ContextItem[], unknown> =>
  Effect.suspend(() => {
    try {
      const result = loader(work);
      if (Effect.isEffect(result)) {
        return result as Effect.Effect<readonly ContextItem[], unknown>;
      }
      if (result instanceof Promise) {
        return Effect.tryPromise({
          try: () => result,
          catch: (cause) => cause,
        });
      }
      return Effect.succeed(result);
    } catch (cause) {
      return Effect.fail(cause);
    }
  });

export const installClaudeTag = (
  app: OpenMatterApplication,
  options: ClaudeTagOptions,
): OpenMatterApplication => {
  const integrationId = "slack";
  const projectAndTurn = (
    work: WorkContext,
    scopeId: string,
    workThreadId: string,
    grant: string,
  ) =>
    Effect.gen(function* () {
      const additionalContext =
        options.context === undefined
          ? []
          : yield* loadContext(options.context, work);
      const context = yield* work.context.project({
        scopeId,
        workThreadId,
        items: [work.context.event(), ...additionalContext],
        grants: [grant],
      });
      const turn = yield* work
        .agent(options.agentId)
        .session({
          scopeId,
          workThreadId,
          privacyPartition: scopeId,
        })
        .turn({ context, allow: context.grants });
      return { context, turn };
    });

  const handleMessage = (work: WorkContext) =>
    Effect.gen(function* () {
      if (!isRecord(work.event.payload)) {
        throw new Error("Claude Tag requires a Slack message payload");
      }
      const {
        activation,
        channelId,
        contextTeamId,
        messageTs,
        threadTs,
        surface,
      } = work.event.payload;
      if (
        work.event.type === `${integrationId}.message.received` &&
        activation !== "direct"
      ) {
        return work.react.none(
          "Claude Tag only auto-activates on direct messages",
        );
      }
      if (
        typeof channelId !== "string" ||
        typeof messageTs !== "string" ||
        typeof threadTs !== "string" ||
        (surface !== "channel" && surface !== "dm")
      ) {
        throw new Error(
          "Claude Tag requires channelId, messageTs, threadTs, and surface",
        );
      }
      const scopeId = `${integrationId}:${work.event.source.authority}:${surface}:${channelId}`;
      const isDmConversation = surface === "dm" && threadTs === messageTs;
      const operation = isDmConversation ? "message.post" : "message.reply";
      const workThreadId = isDmConversation
        ? `${integrationId}:${work.event.source.authority}:${channelId}:dm`
        : `${integrationId}:${work.event.source.authority}:${channelId}:thread:${threadTs}`;
      const { context, turn } = yield* projectAndTurn(
        work,
        scopeId,
        workThreadId,
        `${integrationId}.${operation}`,
      );
      const reply = yield* work.effect(context, {
        integrationId,
        operation,
        input: {
          teamId: work.event.source.authority,
          channelId,
          ...(typeof contextTeamId === "string"
            ? { clientContextTeamId: contextTeamId }
            : {}),
          ...(operation === "message.reply" ? { threadTs } : {}),
          text: outputText(turn.output),
        },
      });
      return work.react.effects([reply]);
    });

  const handleCommand = (work: WorkContext) =>
    Effect.gen(function* () {
      if (!isRecord(work.event.payload)) {
        throw new Error("Claude Tag requires a Slack command payload");
      }
      const { channelId, surface, triggerId, userId } = work.event.payload;
      if (
        typeof channelId !== "string" ||
        typeof triggerId !== "string" ||
        typeof userId !== "string" ||
        (surface !== "channel" && surface !== "dm")
      ) {
        throw new Error(
          "Claude Tag command requires channelId, userId, triggerId, and surface",
        );
      }
      const commandOperation =
        options.commandVisibility === "channel"
          ? "message.post"
          : "message.ephemeral";
      const scopeId = `${integrationId}:${work.event.source.authority}:${surface}:${channelId}`;
      const workThreadId = `${integrationId}:${work.event.source.authority}:${channelId}:command:${triggerId}`;
      const { context, turn } = yield* projectAndTurn(
        work,
        scopeId,
        workThreadId,
        `${integrationId}.${commandOperation}`,
      );
      const reply = yield* work.effect(context, {
        integrationId,
        operation: commandOperation,
        input: {
          teamId: work.event.source.authority,
          channelId,
          ...(commandOperation === "message.ephemeral" ? { userId } : {}),
          text: outputText(turn.output),
        },
      });
      return work.react.effects([reply]);
    });

  app.on(`${integrationId}.message.mentioned`, handleMessage);
  app.on(`${integrationId}.message.received`, handleMessage);
  return app.on(`${integrationId}.command.invoked`, handleCommand);
};

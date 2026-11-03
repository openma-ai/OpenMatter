// The Slack Loop templates. They are guest Loops: they import only
// `@openma/matter-loop`, so a host can run them in process or in an isolate,
// and their definitions are JSON a console can render as a form.

import {
  defineLoop,
  sessionBinding,
  sessionScopeField,
  type JsonValue,
  type LoopConfig,
  type WorkEvent,
} from "@openma/matter-loop";

const VERSION = "0.1.0";

type Fields = { readonly [key: string]: JsonValue };

const isObject = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fields = (event: WorkEvent): Fields =>
  isObject(event.payload) ? event.payload : {};

const text = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const strings = (value: JsonValue | undefined): readonly string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];

/** Where an answer's Session lives. */
const sessionFor = (event: WorkEvent, config: LoopConfig) => {
  const f = fields(event);
  const channelId = text(f.channelId) ?? "unknown";
  return sessionBinding(config.sessionScope, {
    scopeId: `slack:${event.source.authority}:channel:${channelId}`,
    default: "work-item",
    threads: {
      "work-item": `thread:${text(f.threadTs) ?? text(f.messageTs) ?? "unknown"}`,
      global: "channel",
      chat_user: `user:${text(f.userId) ?? "unknown"}`,
      request: `request:${event.id}`,
    },
  });
};

const extra = (config: LoopConfig): string =>
  typeof config.instructions === "string" && config.instructions.trim() !== ""
    ? `\n\n${config.instructions.trim()}`
    : "";

/**
 * Facts about where the message came from and where the answer goes. How to
 * answer (persona, method, tools) belongs to the Agent, not the template.
 */
const contextFor = (event: WorkEvent, config: LoopConfig): string => {
  const f = fields(event);
  const user = text(f.userId);
  return (
    `${user === undefined ? "Someone" : `The Slack user <@${user}>`} ` +
    `${f.activation === "direct" ? "messaged you directly" : "mentioned you in a channel"}; ` +
    `their message is in the event. Your final answer is posted as your reply ` +
    `in the same Slack thread, so write it as Slack mrkdwn.` +
    extra(config)
  );
};

/**
 * Answers Slack messages addressed to the bot (an @mention in a channel, or
 * a direct message) with the configured Agent, and posts the Agent's final
 * output in the thread of the message that asked. Messages by bots, the
 * bot's own included, never reach it: the integration observes them as
 * `slack.event.received`. When the template takes a message it first adds
 * the `acknowledge` reaction, so the sender sees it was picked up.
 *
 * The reply is a durable effect of the Work Item, so a host that retries
 * the Event (a redelivery, a restart) posts it once.
 */
export const slackAgent = defineLoop(
  {
    id: "slack-agent",
    version: VERSION,
    description:
      "Answer Slack @mentions and direct messages with an Agent, in the thread",
    spec: {
      sources: ["slack.message.mentioned", "slack.message.received"],
      workThread: "slack.thread",
      session: "per-work-thread",
      reaction: "effects",
    },
    // The reply is the bot's; a direct message has no other principal.
    runAs: "app",
    requiredBonds: [
      {
        provider: "slack",
        operations: ["chat_write", "reactions_write"],
        runAs: "app",
      },
    ],
    configSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          minLength: 1,
          title: "Agent",
          "x-oma-widget": "agent",
        },
        channels: {
          type: "array",
          items: { type: "string", minLength: 1 },
          default: [],
          title: "Channels",
          description:
            "Channel ids (C…) the bot answers mentions in. Empty: every channel the bot is in. Direct messages are not filtered by this list.",
          "x-oma-widget": "bond-resources",
          "x-bond-provider": "slack",
        },
        directMessages: {
          type: "boolean",
          default: true,
          title: "Answer direct messages",
        },
        sessionScope: sessionScopeField({
          scopes: ["work-item", "global", "chat_user", "request"],
          describe: {
            "work-item": "work-item: one Session per Slack thread",
            global: "global: one Session per channel",
            chat_user: "chat_user: one Session per person in each channel",
          },
        }),
        acknowledge: {
          type: "string",
          maxLength: 64,
          default: "eyes",
          title: "Acknowledgement",
          description:
            "Emoji name added to a message when the bot takes it, such as eyes. Empty: none.",
        },
        instructions: {
          type: "string",
          default: "",
          title: "Extra instructions",
          description: "Appended to the instructions the Agent receives",
        },
      },
      required: ["agentId"],
    },
  },
  (app) =>
    app.on(
      ["slack.message.mentioned", "slack.message.received"],
      async (work) => {
        const f = fields(work.event);
        const channelId = text(f.channelId);
        const messageTs = text(f.messageTs);
        const threadTs = text(f.threadTs) ?? messageTs;
        if (
          channelId === undefined ||
          messageTs === undefined ||
          threadTs === undefined
        ) {
          return work.react.none("Not a Slack message");
        }
        const direct = f.activation === "direct";
        if (work.event.type === "slack.message.received" && !direct) {
          // Channel traffic and thread replies without a mention.
          return work.react.none("Not addressed to the bot");
        }
        if (direct && work.config.directMessages === false) {
          return work.react.none("Direct messages are off");
        }
        const channels = strings(work.config.channels);
        if (!direct && channels.length > 0 && !channels.includes(channelId)) {
          return work.react.none("Channel is not watched");
        }
        const prompt = text(f.prompt);
        const images = Array.isArray(f.images) ? f.images.length : 0;
        if ((prompt === undefined || prompt.trim() === "") && images === 0) {
          return work.react.none("Empty message");
        }

        const teamId = work.event.source.authority;
        const contextTeamId = text(f.contextTeamId);
        const target = {
          teamId,
          channelId,
          ...(contextTeamId === undefined
            ? {}
            : { clientContextTeamId: contextTeamId }),
        };
        const binding = sessionFor(work.event, work.config);
        const capability = "slack.message.reply";
        const acknowledge = text(work.config.acknowledge);
        const context = await work.context.project({
          scopeId: binding.scopeId,
          workThreadId: binding.workThreadId,
          items: [
            work.context.event(),
            work.context.value({
              kind: "instructions",
              value: contextFor(work.event, work.config),
              provenance: [{ sourceType: "loop-template", sourceId: "slack" }],
            }),
          ],
          grants:
            acknowledge === undefined
              ? [capability]
              : [capability, "slack.message.react"],
        });
        if (acknowledge !== undefined) {
          // Best effort: a failed acknowledgement does not stop the answer.
          await work.acknowledge(context, {
            integrationId: "slack",
            operation: "message.react",
            input: { ...target, messageTs, emoji: acknowledge },
          });
        }
        const turn = await work
          .agent(String(work.config.agentId))
          .session(binding)
          .turn({ context, allow: [capability] });
        const body = typeof turn.output === "string" ? turn.output.trim() : "";
        if (turn.outcome !== "completed" || body.length === 0) {
          return work.react.none(
            turn.outcome === "completed"
              ? "The Agent produced no reply"
              : `The Agent Turn ended ${turn.outcome}`,
          );
        }
        const reply = await work.effect(context, {
          integrationId: "slack",
          operation: "message.reply",
          input: { ...target, threadTs, text: body },
        });
        return work.react.effects([reply]);
      },
    ),
);

/** The Slack templates, in the order a console lists them. */
export const slackTemplates = [slackAgent] as const;

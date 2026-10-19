// The Feishu Loop templates. They are guest Loops: they import only
// `@openma/matter-loop`, so a host can run them in process or in an isolate,
// and their definitions are JSON a console can render as a form.

import {
  defineLoop,
  freshnessField,
  freshnessPolicy,
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

/**
 * The callback method of an operation the Agent calls (`OPERATION_CALL_METHOD`
 * in `@openma/matter/agent`). A template may import only
 * `@openma/matter-loop`, so it names it itself; a test keeps the two equal.
 */
export const TEMPLATE_OPERATION_CALL_METHOD = "openmatter/operation";

/** Whether the Agent called the reply tool during its Turn. */
const calledReply = (events: readonly JsonValue[]): boolean =>
  events.some((e) => {
    if (!isObject(e) || e.type !== "callback.requested" || !isObject(e.data)) {
      return false;
    }
    const params = isObject(e.data.params) ? e.data.params : {};
    return (
      e.data.method === TEMPLATE_OPERATION_CALL_METHOD &&
      params.integrationId === "feishu" &&
      params.operation === "message.reply"
    );
  });

/** Where an answer's Session lives. */
const sessionFor = (
  event: WorkEvent,
  config: LoopConfig,
): {
  readonly scopeId: string;
  readonly workThreadId: string;
  readonly privacyPartition: string;
} => {
  const f = fields(event);
  const chatId = text(f.chatId) ?? "unknown";
  const scopeId = `feishu:${event.source.authority}:chat:${chatId}`;
  const sender = isObject(f.sender) ? text(f.sender.openId) : undefined;
  const workThreadId =
    config.sessionScope === "chat"
      ? "chat"
      : config.sessionScope === "chat_user"
        ? `user:${sender ?? "unknown"}`
        : `thread:${text(f.threadId) ?? text(f.messageId) ?? "unknown"}`;
  return { scopeId, workThreadId, privacyPartition: scopeId };
};

/**
 * Facts about where the message came from and where the answer goes. How to
 * answer (persona, method, tools) belongs to the Agent, not the template.
 */
const contextFor = (event: WorkEvent): string => {
  const f = fields(event);
  const sender = isObject(f.sender) ? text(f.sender.openId) : undefined;
  return (
    `${sender === undefined ? "Someone" : `The Feishu user ${sender}`} ` +
    `${f.activation === "direct" ? "messaged you directly" : "mentioned you in a group chat"}; ` +
    `their message is in the event. You act on their behalf. To answer, call ` +
    `the feishu.message.reply tool; your final output is not posted.`
  );
};

/**
 * Answers Feishu messages addressed to the bot (a direct message, or a group
 * @mention) with the configured Agent. The Agent replies by calling the
 * `feishu.message.reply` tool during its Turn; the reply is bound to the
 * message that asked and checked against newer messages in the chat under the
 * instance's freshness setting, and a conflict goes back to the Agent. The
 * template owns ingress (which chats and messages, and which it observes),
 * the Session binding, and the tool it allows. The Agent owns behaviour and
 * its other tools: what it may reach, such as GitLab projects, is its own
 * Bond grant, and the Session runs as the person who asked
 * (`runAs: "requester"`), so it sees only what they can. The reply itself is
 * always posted by the bot. When the template takes a message, it first
 * adds the `acknowledge` reaction to it so the sender sees it was picked up.
 */
export const feishuAgent = defineLoop(
  {
    id: "feishu-agent",
    version: VERSION,
    description:
      "Answer Feishu messages to the bot with an Agent acting for the person who asked",
    spec: {
      sources: ["feishu.message.mentioned"],
      // Newer messages and recalls the reply is checked against.
      observes: ["feishu.message.received", "feishu.message.recalled"],
      workThread: "feishu.thread",
      session: "per-work-thread",
      reaction: "tools",
    },
    // The Session acts for the person who asked; the reply is the bot's.
    runAs: "requester",
    requiredBonds: [
      { provider: "feishu", operations: ["im_send", "im_react"], runAs: "app" },
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
        chats: {
          type: "array",
          items: { type: "string", minLength: 1 },
          default: [],
          title: "Chats",
          description:
            "Group chats the bot answers in. Empty: every chat the bot is in. Direct messages are always answered.",
          "x-oma-widget": "bond-resources",
          "x-bond-provider": "feishu",
        },
        sessionScope: {
          type: "string",
          enum: ["thread", "chat", "chat_user"],
          default: "thread",
          title: "Conversation memory",
          description:
            "thread: one Session per topic thread; chat: one per chat; chat_user: one per person in each chat",
          "x-oma-widget": "select",
        },
        acknowledge: {
          type: "string",
          maxLength: 64,
          default: "OnIt",
          title: "Acknowledgement",
          description:
            "Feishu emoji_type added to a message when the bot takes it, such as OnIt or THUMBSUP. Empty: none.",
        },
        freshness: freshnessField(),
      },
      required: ["agentId"],
    },
  },
  (app) =>
    app.on("feishu.message.mentioned", async (work) => {
      const f = fields(work.event);
      const messageId = text(f.messageId);
      const resource = text(f.resource);
      const direct = f.activation === "direct";
      if (messageId === undefined || resource === undefined) {
        return work.react.none("Not a Feishu message");
      }
      if (f.senderType === "app") return work.react.none("A bot's message");
      const chats = strings(work.config.chats);
      if (!direct && chats.length > 0 && !chats.includes(resource)) {
        return work.react.none("Chat is not watched");
      }
      // An image alone is a message; the Agent sees it in `payload.images`.
      const prompt = text(f.prompt);
      const images = Array.isArray(f.images) ? f.images.length : 0;
      if ((prompt === undefined || prompt.trim() === "") && images === 0) {
        return work.react.none("Empty message");
      }

      const binding = sessionFor(work.event, work.config);
      const capability = "feishu.message.reply";
      const acknowledge = text(work.config.acknowledge);
      const context = await work.context.project({
        scopeId: binding.scopeId,
        workThreadId: binding.workThreadId,
        items: [
          work.context.event(),
          work.context.value({
            kind: "instructions",
            value: contextFor(work.event),
            provenance: [{ sourceType: "loop-template", sourceId: "feishu" }],
          }),
        ],
        grants:
          acknowledge === undefined
            ? [capability]
            : [capability, "feishu.reaction.add"],
      });
      if (acknowledge !== undefined) {
        // Best effort: a failed acknowledgement does not stop the answer.
        await work.acknowledge(context, {
          integrationId: "feishu",
          operation: "reaction.add",
          input: {
            authority: work.event.source.authority,
            messageId,
            emoji: acknowledge,
          },
        });
      }
      const turn = await work
        .agent(String(work.config.agentId))
        .session(binding)
        .turn({
          context,
          allow: [capability],
          freshness: freshnessPolicy(work.config.freshness),
        });
      if (turn.outcome !== "completed") {
        return work.react.none(`The Agent Turn ended ${turn.outcome}`);
      }
      return work.react.none(
        calledReply(turn.events)
          ? "The Agent called the reply tool"
          : "The Agent did not reply",
      );
    }),
);

/** The Feishu templates, in the order a console lists them. */
export const feishuTemplates = [feishuAgent] as const;

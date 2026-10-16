// The Feishu Loop templates. They are guest Loops: they import only
// `@openma/matter-loop`, so a host can run them in process or in an isolate,
// and their definitions are JSON a console can render as a form.

import {
  defineLoop,
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
 * The same Card JSON 2.0 shape as `feishuMarkdownCard` in the Integration.
 * A template may import only `@openma/matter-loop`, so it builds the card
 * itself; a test keeps the two equal.
 */
export const templateMarkdownCard = (markdown: string): JsonValue => ({
  schema: "2.0",
  config: { update_multi: true },
  body: { elements: [{ tag: "markdown", content: markdown }] },
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

const instructionsFor = (event: WorkEvent, config: LoopConfig): string => {
  const f = fields(event);
  const projects = strings(config.gitlabProjects);
  const sender = isObject(f.sender) ? text(f.sender.openId) : undefined;
  const extra =
    typeof config.instructions === "string" && config.instructions.trim() !== ""
      ? `\n\n${config.instructions.trim()}`
      : "";
  return (
    `${sender === undefined ? "Someone" : `The Feishu user ${sender}`} ` +
    `${f.activation === "direct" ? "messaged you directly" : "mentioned you in a group chat"}. ` +
    `Their message is in the event. Answer it.\n\n` +
    `You can read these GitLab projects through the GitLab Bond, as the person ` +
    `who asked, so you see only what they can see: ${projects.join(", ")}. ` +
    `Fetch code, issues, merge requests, and pipelines there when the question ` +
    `needs them, and cite paths and line numbers. Do not change anything in ` +
    `GitLab. Your reply is posted in Feishu as markdown; keep it concise.` +
    extra
  );
};

/**
 * Answers Feishu messages addressed to the bot (a direct message, or a group
 * @mention) with an Agent that can read the configured GitLab projects.
 * GitLab is read as the person who asked (`runAs: "requester"`), so the
 * Agent sees only what they can; the reply is posted by the bot. A bug-triage
 * bot is this template with triage instructions.
 */
export const feishuAgent = defineLoop(
  {
    id: "feishu-agent",
    version: VERSION,
    description:
      "Answer Feishu messages to the bot with an Agent that reads GitLab as the person who asked",
    spec: {
      sources: ["feishu.message.mentioned"],
      workThread: "feishu.thread",
      session: "per-work-thread",
      reaction: "effects",
    },
    runAs: "app",
    requiredBonds: [
      {
        provider: "gitlab",
        operations: ["fetch", "read"],
        runAs: "requester",
      },
      { provider: "feishu", operations: ["im_send"] },
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
        gitlabProjects: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          title: "GitLab projects",
          description: "The projects the Agent may read",
          "x-oma-widget": "bond-resources",
          "x-bond-provider": "gitlab",
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
        instructions: {
          type: "string",
          default: "",
          title: "Extra instructions",
          description:
            "Appended to the Agent's instructions, for example how to triage a bug report",
          "x-oma-widget": "textarea",
        },
      },
      required: ["agentId", "gitlabProjects"],
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
      const prompt = text(f.prompt);
      if (prompt === undefined || prompt.trim() === "") {
        return work.react.none("Empty message");
      }

      const binding = sessionFor(work.event, work.config);
      const capability = "feishu.message.reply";
      const context = await work.context.project({
        scopeId: binding.scopeId,
        workThreadId: binding.workThreadId,
        items: [
          work.context.event(),
          work.context.value({
            kind: "instructions",
            value: instructionsFor(work.event, work.config),
            provenance: [{ sourceType: "loop-template", sourceId: "feishu" }],
          }),
        ],
        grants: [capability],
      });
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
        integrationId: "feishu",
        operation: "message.reply",
        input: {
          authority: work.event.source.authority,
          messageId,
          card: templateMarkdownCard(body),
          // A group reply goes to the message's topic; a direct chat has none.
          ...(direct ? {} : { inThread: true }),
        },
      });
      return work.react.effects([reply]);
    }),
);

/** The Feishu templates, in the order a console lists them. */
export const feishuTemplates = [feishuAgent] as const;

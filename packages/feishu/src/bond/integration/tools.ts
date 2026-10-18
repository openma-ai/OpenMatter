// What an Agent sees of Feishu during its Turn: the conversation messages
// the runtime records, and the reply tool with its target bound from the
// message that started the Turn.

import type {
  ConversationObservation,
  JsonValue,
  WorkEvent,
} from "@openma/matter";
import type { IntegrationManifest } from "@openma/matter/integration";
import { feishuMarkdownCard } from "./delivery.js";
import { isRecord, nonEmptyString } from "./shared.js";

/** Tools an Agent may call, checked against newer messages in the chat. */
export const FEISHU_TOOLS: NonNullable<IntegrationManifest["tools"]> = {
  "message.reply": {
    description:
      "Reply to the Feishu message you were asked in, as the bot. In a group the reply goes to the message's topic. If newer messages arrived while you worked, nothing is posted and they are returned to you; read them and call again, with a revised reply or the same one, or do not reply.",
    inputSchema: {
      type: "object",
      properties: {
        markdown: {
          type: "string",
          minLength: 1,
          description:
            "The reply, as Feishu card markdown: headings, lists, links, and code are rendered.",
        },
      },
      required: ["markdown"],
      additionalProperties: false,
    },
    freshness: "best-effort",
  },
};

const fieldsOf = (event: WorkEvent): Record<string, unknown> =>
  isRecord(event.payload) ? event.payload : {};

/**
 * Feishu's own topic id of a message, or `main` for the chat's main flow.
 * A quote reply outside a topic carries a `root_id` but no `thread_id`, and
 * shows in the main flow, so it is `main` too.
 */
const topicOf = (event: WorkEvent): string => {
  const raw = isRecord(event.raw) ? event.raw : {};
  const body = isRecord(raw.event) ? raw.event : {};
  const message = isRecord(body.message) ? body.message : {};
  return nonEmptyString(message.thread_id) ? message.thread_id : "main";
};

/**
 * A Feishu message, mention, or recall as a conversation message. The thread
 * is the topic, or `main` for the chat's main flow, so a correction posted in
 * the main flow counts against a question asked there.
 */
export const observeFeishuEvent = (
  event: WorkEvent,
): ConversationObservation | undefined => {
  const f = fieldsOf(event);
  if (!nonEmptyString(f.chatId)) return undefined;
  if (event.type === "feishu.message.recalled") {
    return nonEmptyString(f.messageId)
      ? { conversationId: f.chatId, kind: "recall", messageId: f.messageId }
      : undefined;
  }
  if (
    event.type !== "feishu.message.received" &&
    event.type !== "feishu.message.mentioned"
  ) {
    return undefined;
  }
  const sender =
    isRecord(f.sender) && nonEmptyString(f.sender.openId)
      ? f.sender.openId
      : undefined;
  return {
    conversationId: f.chatId,
    kind: event.type === "feishu.message.mentioned" ? "mention" : "message",
    threadId: topicOf(event),
    ...(nonEmptyString(f.messageId) ? { messageId: f.messageId } : {}),
    ...(sender === undefined
      ? {}
      : {
          sender: {
            id: sender,
            kind: f.senderType === "user" ? "human" : "app",
          },
        }),
    ...(typeof f.text === "string" ? { text: f.text } : {}),
  };
};

/**
 * Binds a reply to the message that started the Turn: the Agent supplies
 * only `markdown`; the authority, the target message, and whether to reply
 * in the topic come from the trigger.
 */
export const bindFeishuToolInput = (
  operation: string,
  input: JsonValue,
  trigger: WorkEvent,
): { readonly input: JsonValue } | { readonly refused: string } => {
  if (operation !== "message.reply") {
    return { refused: `Feishu has no tool ${operation}` };
  }
  if (
    !isRecord(input) ||
    !nonEmptyString(input.markdown) ||
    input.markdown.trim() === "" ||
    Object.keys(input).some((key) => key !== "markdown")
  ) {
    return { refused: "A reply needs exactly one non-empty markdown string" };
  }
  const f = fieldsOf(trigger);
  if (
    trigger.source.provider !== "feishu" ||
    (trigger.type !== "feishu.message.mentioned" &&
      trigger.type !== "feishu.message.received") ||
    !nonEmptyString(f.messageId)
  ) {
    return { refused: "This Turn was not started by a Feishu message" };
  }
  return {
    input: {
      authority: trigger.source.authority,
      messageId: f.messageId,
      card: feishuMarkdownCard(input.markdown),
      // A group reply goes to the message's topic; a direct chat has none.
      ...(f.activation === "direct" ? {} : { inThread: true }),
    },
  };
};

import {
  JsonValueSchema,
  type JsonValue,
  type WorkEvent,
} from "@openma/matter";
import { IntegrationError } from "@openma/matter/integration";
import { Effect, Schema } from "effect";
import type { FeishuEventInput } from "./http.js";
import {
  epochToIso,
  feishuSource,
  isRecord,
  nonEmptyString,
  withoutFeishuCredentials,
} from "./shared.js";

/** Every Event type `ingest` can produce. */
export const FEISHU_EVENT_TYPES: readonly string[] = [
  "feishu.message.received",
  "feishu.message.mentioned",
  "feishu.message.recalled",
  "feishu.reaction.added",
  "feishu.reaction.removed",
  "feishu.chat.bot_added",
  "feishu.chat.bot_removed",
  "feishu.menu.invoked",
  "feishu.card.action",
  "feishu.event.received",
];

type Fields = Record<string, JsonValue>;
type Rec = Record<string, unknown>;

const optional = (key: string, value: JsonValue | undefined): Fields =>
  value === undefined ? {} : { [key]: value };

const str = (value: unknown): string | undefined =>
  nonEmptyString(value) ? value : undefined;

/** `{ open_id, union_id, user_id }` → portable ids, open_id first. */
const userIds = (value: unknown): Fields | undefined => {
  if (!isRecord(value)) return undefined;
  const ids: Fields = {
    ...optional("openId", str(value.open_id)),
    ...optional("unionId", str(value.union_id)),
    ...optional("userId", str(value.user_id)),
  };
  return Object.keys(ids).length === 0 ? undefined : ids;
};

interface Mention {
  readonly key: string;
  readonly name: string;
  readonly openId?: string;
}

const mentionsOf = (value: unknown): Mention[] =>
  Array.isArray(value)
    ? value.flatMap((m) => {
        if (!isRecord(m) || !nonEmptyString(m.key)) return [];
        const openId = isRecord(m.id) ? str(m.id.open_id) : undefined;
        return [
          {
            key: m.key,
            name: typeof m.name === "string" ? m.name : "",
            ...(openId === undefined ? {} : { openId }),
          },
        ];
      })
    : [];

/** Flattens a `post` body, with or without a locale wrapper. */
const postText = (content: Rec): string | undefined => {
  const body = Array.isArray(content.content)
    ? content
    : Object.values(content).find(
        (v): v is Rec => isRecord(v) && Array.isArray(v.content),
      );
  if (body === undefined) return undefined;
  const lines = (body.content as unknown[]).map((line) =>
    Array.isArray(line)
      ? line
          .map((node) => {
            if (!isRecord(node)) return "";
            if (node.tag === "text" || node.tag === "a")
              return typeof node.text === "string" ? node.text : "";
            if (node.tag === "at")
              return typeof node.user_id === "string"
                ? `@${node.user_name ?? node.user_id}`
                : "";
            return "";
          })
          .join("")
      : "",
  );
  const title = typeof body.title === "string" ? body.title : "";
  return [title, ...lines].filter((l) => l.length > 0).join("\n");
};

/** The readable text of a `text` or `post` message; undefined for others. */
const messageText = (
  messageType: unknown,
  content: unknown,
): string | undefined => {
  if (typeof content !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (messageType === "text")
    return typeof parsed.text === "string" ? parsed.text : undefined;
  if (messageType === "post") return postText(parsed);
  return undefined;
};

/**
 * The text addressed to the bot: the bot's own `@_user_n` placeholder is
 * removed and other mentions become `@name`.
 */
const promptOf = (
  text: string,
  mentions: readonly Mention[],
  botOpenId: string | undefined,
): string => {
  let prompt = text;
  for (const m of mentions) {
    prompt = prompt
      .split(m.key)
      .join(
        botOpenId !== undefined && m.openId === botOpenId ? "" : `@${m.name}`,
      );
  }
  return prompt.replace(/[ \t]+/g, " ").trim();
};

interface Normalized {
  readonly type: string;
  /** The dedup key: `message_id` for messages, `event:<event_id>` otherwise. */
  readonly key: string;
  readonly chatId?: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly occurredAt?: string;
  readonly fields: Fields;
}

const messageReceived = (
  event: Rec,
  eventKey: string,
  botOpenId: string | undefined,
): Normalized => {
  const message = isRecord(event.message) ? event.message : {};
  const sender = isRecord(event.sender) ? event.sender : {};
  const messageId = str(message.message_id);
  const chatId = str(message.chat_id);
  const chatType = str(message.chat_type);
  const mentions = mentionsOf(message.mentions);
  const direct = chatType === "p2p";
  const mentioned =
    botOpenId !== undefined && mentions.some((m) => m.openId === botOpenId);
  const threadId = str(message.thread_id) ?? str(message.root_id) ?? messageId;
  const text = messageText(message.message_type, message.content);
  const senderIds = userIds(sender.sender_id);
  return {
    type:
      direct || mentioned
        ? "feishu.message.mentioned"
        : "feishu.message.received",
    // Feishu says to dedup messages by message_id, not event_id.
    key: messageId ?? eventKey,
    ...(chatId === undefined ? {} : { chatId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(messageId === undefined ? {} : { messageId }),
    ...optionalOccurred(epochToIso(message.create_time)),
    fields: {
      activation: direct ? "direct" : mentioned ? "mention" : "observation",
      surface: direct ? "p2p" : "group",
      ...optional("chatId", chatId),
      ...optional("chatType", chatType),
      ...optional(
        "resource",
        chatId === undefined ? undefined : `chat:${chatId}`,
      ),
      ...optional("messageId", messageId),
      ...optional("threadId", threadId),
      ...optional("rootId", str(message.root_id)),
      ...optional("parentId", str(message.parent_id)),
      ...optional("messageType", str(message.message_type)),
      ...optional("text", text),
      ...optional(
        "prompt",
        text === undefined ? undefined : promptOf(text, mentions, botOpenId),
      ),
      ...(senderIds === undefined ? {} : { sender: senderIds }),
      ...optional("senderType", str(sender.sender_type)),
      mentions: mentions.map((m) => ({
        key: m.key,
        name: m.name,
        ...optional("openId", m.openId),
      })),
    },
  };
};

const optionalOccurred = (occurredAt: string | undefined) =>
  occurredAt === undefined ? {} : { occurredAt };

const byEvent = (
  eventType: string,
  event: Rec,
  eventKey: string,
): Normalized => {
  switch (eventType) {
    case "im.message.recalled_v1": {
      const messageId = str(event.message_id);
      const chatId = str(event.chat_id);
      return {
        type: "feishu.message.recalled",
        key: eventKey,
        ...(chatId === undefined ? {} : { chatId }),
        ...(messageId === undefined ? {} : { messageId }),
        ...optionalOccurred(epochToIso(event.recall_time)),
        fields: {
          activation: "observation",
          ...optional("chatId", chatId),
          ...optional(
            "resource",
            chatId === undefined ? undefined : `chat:${chatId}`,
          ),
          ...optional("messageId", messageId),
          ...optional("recallType", str(event.recall_type)),
        },
      };
    }
    case "im.message.reaction.created_v1":
    case "im.message.reaction.deleted_v1": {
      const messageId = str(event.message_id);
      const reaction = isRecord(event.reaction_type)
        ? str(event.reaction_type.emoji_type)
        : undefined;
      const operator = userIds(event.user_id);
      return {
        type:
          eventType === "im.message.reaction.created_v1"
            ? "feishu.reaction.added"
            : "feishu.reaction.removed",
        key: eventKey,
        ...(messageId === undefined ? {} : { messageId }),
        ...optionalOccurred(epochToIso(event.action_time)),
        fields: {
          activation: "observation",
          ...optional("messageId", messageId),
          ...optional("emoji", reaction),
          ...optional("operatorType", str(event.operator_type)),
          ...(operator === undefined ? {} : { operator }),
        },
      };
    }
    case "im.chat.member.bot.added_v1":
    case "im.chat.member.bot.deleted_v1": {
      const chatId = str(event.chat_id);
      const operator = userIds(event.operator_id);
      return {
        type:
          eventType === "im.chat.member.bot.added_v1"
            ? "feishu.chat.bot_added"
            : "feishu.chat.bot_removed",
        key: eventKey,
        ...(chatId === undefined ? {} : { chatId }),
        fields: {
          activation: "observation",
          ...optional("chatId", chatId),
          ...optional(
            "resource",
            chatId === undefined ? undefined : `chat:${chatId}`,
          ),
          ...optional("chatName", str(event.name)),
          ...(operator === undefined ? {} : { operator }),
        },
      };
    }
    case "application.bot.menu_v6": {
      const operator = isRecord(event.operator)
        ? userIds(event.operator.operator_id)
        : undefined;
      return {
        type: "feishu.menu.invoked",
        key: eventKey,
        ...optionalOccurred(epochToIso(event.timestamp)),
        fields: {
          activation: "command",
          ...optional("eventKey", str(event.event_key)),
          ...(operator === undefined ? {} : { operator }),
        },
      };
    }
    case "card.action.trigger": {
      const context = isRecord(event.context) ? event.context : {};
      const action = isRecord(event.action) ? event.action : {};
      const chatId = str(context.open_chat_id);
      const messageId = str(context.open_message_id);
      const operator = isRecord(event.operator)
        ? userIds(event.operator)
        : undefined;
      const value = action.value;
      return {
        type: "feishu.card.action",
        key: eventKey,
        ...(chatId === undefined ? {} : { chatId }),
        ...(messageId === undefined ? {} : { messageId, threadId: messageId }),
        fields: {
          activation: "action",
          ...optional("chatId", chatId),
          ...optional(
            "resource",
            chatId === undefined ? undefined : `chat:${chatId}`,
          ),
          ...optional("messageId", messageId),
          ...optional("tag", str(action.tag)),
          ...optional("name", str(action.name)),
          ...optional("option", str(action.option)),
          ...(value !== undefined && Schema.is(JsonValueSchema)(value)
            ? { value: withoutFeishuCredentials(value as JsonValue) }
            : {}),
          ...(operator === undefined ? {} : { operator }),
        },
      };
    }
    default:
      return {
        type: "feishu.event.received",
        key: eventKey,
        fields: {
          activation: "observation",
          eventType,
          event: withoutFeishuCredentials(event as JsonValue),
        },
      };
  }
};

/**
 * The Event id (and idempotency key) `normalizeFeishuEvents` gives an
 * envelope: `feishu:<authority>:<message_id>` for a received message and
 * `feishu:<authority>:event:<event_id>` otherwise. Transports use it as the
 * inbox item id so a redelivery is stored once. Undefined for an envelope
 * without a v2 header.
 */
export const feishuEventId = (
  authority: string,
  envelope: unknown,
): string | undefined => {
  if (!isRecord(envelope) || !isRecord(envelope.header)) return undefined;
  const head = envelope.header;
  if (!nonEmptyString(head.event_id) || !nonEmptyString(head.event_type))
    return undefined;
  const messageId =
    head.event_type === "im.message.receive_v1" &&
    isRecord(envelope.event) &&
    isRecord(envelope.event.message)
      ? str(envelope.event.message.message_id)
      : undefined;
  return `feishu:${authority}:${messageId ?? `event:${head.event_id}`}`;
};

/**
 * The id of one delivery, `feishu:<authority>:event:<event_id>`, for a
 * transport inbox. It differs from `feishuEventId`: Feishu may push the same
 * message under several event ids, each with a different envelope, and an
 * inbox refuses a reused key with a different body. Each delivery is stored
 * once; deliveries of one message normalize to one Event id, which the
 * runtime processes once.
 */
export const feishuDeliveryId = (
  authority: string,
  envelope: unknown,
): string | undefined =>
  isRecord(envelope) &&
  isRecord(envelope.header) &&
  nonEmptyString(envelope.header.event_id) &&
  nonEmptyString(envelope.header.event_type)
    ? `feishu:${authority}:event:${envelope.header.event_id}`
    : undefined;

/**
 * Normalizes one `FeishuEventInput`. Event ids are
 * `feishu:<authority>:<message_id>` for received messages (Feishu redelivers
 * a message under a new event id) and `feishu:<authority>:event:<event_id>`
 * for everything else. Input that is not a Feishu event yields no Events.
 */
export const normalizeFeishuEvents = (
  input: unknown,
  clock: () => string = () => new Date().toISOString(),
): Effect.Effect<readonly WorkEvent[], IntegrationError> =>
  Effect.try({
    try: () => {
      if (
        !isRecord(input) ||
        input.kind !== "feishu.event" ||
        !nonEmptyString(input.authority) ||
        !isRecord(input.envelope) ||
        !Schema.is(JsonValueSchema)(input.envelope)
      ) {
        return [];
      }
      const typed = input as unknown as FeishuEventInput;
      const envelope = input.envelope;
      const head = isRecord(envelope.header) ? envelope.header : undefined;
      const event = isRecord(envelope.event) ? envelope.event : undefined;
      if (
        head === undefined ||
        event === undefined ||
        !nonEmptyString(head.event_id) ||
        !nonEmptyString(head.event_type)
      ) {
        return [];
      }
      const eventKey = `event:${head.event_id}`;
      const botOpenId = str(typed.botOpenId);
      const normalized =
        head.event_type === "im.message.receive_v1"
          ? messageReceived(event, eventKey, botOpenId)
          : byEvent(head.event_type, event, eventKey);
      const receivedAt = clock();
      const id = `feishu:${typed.authority}:${normalized.key}`;
      const result: WorkEvent = {
        schemaVersion: "0.1",
        id,
        type: normalized.type,
        occurredAt:
          normalized.occurredAt ?? epochToIso(head.create_time) ?? receivedAt,
        receivedAt,
        idempotencyKey: id,
        source: feishuSource({
          authority: typed.authority,
          ...(normalized.chatId === undefined
            ? {}
            : { chatId: normalized.chatId }),
          ...(normalized.threadId === undefined
            ? {}
            : { threadId: normalized.threadId }),
          ...(normalized.messageId === undefined
            ? {}
            : { messageId: normalized.messageId }),
        }),
        payload: {
          authority: typed.authority,
          transport: typed.transport,
          eventType: head.event_type,
          eventId: head.event_id,
          ...optional("appId", str(head.app_id)),
          ...optional("tenantKey", str(head.tenant_key)),
          ...normalized.fields,
        },
        raw: withoutFeishuCredentials(envelope as JsonValue),
      };
      return [result];
    },
    catch: (cause) =>
      new IntegrationError({
        message: "Unable to normalize Feishu event",
        retryable: false,
        cause,
      }),
  });

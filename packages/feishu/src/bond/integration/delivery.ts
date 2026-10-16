import type { JsonValue } from "@openma/matter";
import {
  IntegrationError,
  type WorkIntegration,
} from "@openma/matter/integration";
import { Effect } from "effect";
import type { FeishuClient } from "./client.js";
import { isRecord, nonEmptyString } from "./shared.js";

/** Every Effect operation `deliver` accepts. */
export const FEISHU_OPERATIONS = [
  "message.send",
  "message.reply",
  "reaction.add",
  "card.update",
] as const;

export type FeishuEffectOperation = (typeof FEISHU_OPERATIONS)[number];

/** Feishu's limits for one text message and one card, in bytes of UTF-8. */
const MAX_TEXT_BYTES = 150 * 1024;
const MAX_CARD_BYTES = 30 * 1024;

const fail = (message: string) =>
  Effect.fail(new IntegrationError({ message, retryable: false }));

const utf8Length = (value: string) => new TextEncoder().encode(value).length;

/**
 * A Card JSON 2.0 card with one markdown element, so an Agent reply renders
 * headings, lists, links, and code. Use it as the `card` of `message.send`
 * or `message.reply`.
 */
export const feishuMarkdownCard = (
  markdown: string,
  options: { readonly title?: string } = {},
): JsonValue => ({
  schema: "2.0",
  config: { update_multi: true },
  ...(options.title === undefined
    ? {}
    : {
        header: {
          title: { tag: "plain_text", content: options.title },
          template: "blue",
        },
      }),
  body: { elements: [{ tag: "markdown", content: markdown }] },
});

/**
 * Feishu deduplicates a send or reply by `uuid` for one hour, at most 50
 * characters. The Effect idempotency key is longer, so the uuid is a digest
 * of it: a redelivered Effect posts once.
 */
const feishuUuid = (idempotencyKey: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = new Uint8Array(
      await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(idempotencyKey),
      ),
    );
    return Array.from(digest.slice(0, 16), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
  });

type Content =
  | { readonly msgType: "text"; readonly content: string }
  | { readonly msgType: "interactive"; readonly content: string };

/** Exactly one of `text` and `card`. */
const messageContent = (
  operation: string,
  input: Record<string, unknown>,
): Content | string => {
  const { text, card } = input;
  if ((text === undefined) === (card === undefined)) {
    return `Feishu ${operation} requires exactly one of text and card`;
  }
  if (text !== undefined) {
    if (!nonEmptyString(text) || text.trim() === "") {
      return `Feishu ${operation} text must be a non-empty string`;
    }
    const content = JSON.stringify({ text });
    return utf8Length(content) > MAX_TEXT_BYTES
      ? `Feishu ${operation} text exceeds ${MAX_TEXT_BYTES} bytes`
      : { msgType: "text", content };
  }
  if (!isRecord(card)) return `Feishu ${operation} card must be an object`;
  const content = JSON.stringify(card);
  return utf8Length(content) > MAX_CARD_BYTES
    ? `Feishu ${operation} card exceeds ${MAX_CARD_BYTES} bytes`
    : { msgType: "interactive", content };
};

const ID = /^[A-Za-z0-9_-]+$/;
const isId = (value: unknown, prefix: string): value is string =>
  typeof value === "string" && value.startsWith(prefix) && ID.test(value);

const messageReceipt = (data: JsonValue) =>
  isRecord(data) && nonEmptyString(data.message_id)
    ? {
        messageId: data.message_id,
        ...(nonEmptyString(data.thread_id) ? { threadId: data.thread_id } : {}),
      }
    : null;

/**
 * Delivers Feishu Effects as the authority's bot. Every input names the
 * `authority` whose tenant token posts:
 *
 * - `message.send` `{ chatId, text | card }` posts to a chat.
 * - `message.reply` `{ messageId, text | card, inThread? }` replies to a
 *   message; `inThread` replies in its topic thread.
 * - `reaction.add` `{ messageId, emoji }` adds a reaction such as `THUMBSUP`.
 * - `card.update` `{ messageId, card }` replaces a card the bot sent; the
 *   card must have `config.update_multi` (as `feishuMarkdownCard` does).
 *
 * Sends and replies carry a uuid derived from the Effect idempotency key.
 */
export const makeFeishuDelivery =
  (client: Pick<FeishuClient, "request">): WorkIntegration["deliver"] =>
  (effect) => {
    const operation = FEISHU_OPERATIONS.find(
      (name) => name === effect.operation,
    );
    if (effect.integrationId !== "feishu" || operation === undefined) {
      return fail(`Feishu does not support the operation ${effect.operation}`);
    }
    const input = effect.input;
    if (!isRecord(input) || !nonEmptyString(input.authority)) {
      return fail(`Feishu ${operation} requires an object with an authority`);
    }
    const authority = input.authority;
    switch (operation) {
      case "message.send": {
        if (!isId(input.chatId, "oc_")) {
          return fail("Feishu message.send requires a chatId (oc_…)");
        }
        const content = messageContent(operation, input);
        if (typeof content === "string") return fail(content);
        const chatId = input.chatId;
        return feishuUuid(effect.idempotencyKey).pipe(
          Effect.flatMap((uuid) =>
            client.request({
              authority,
              method: "POST",
              path: "/im/v1/messages",
              query: { receive_id_type: "chat_id" },
              body: {
                receive_id: chatId,
                msg_type: content.msgType,
                content: content.content,
                uuid,
              },
            }),
          ),
          Effect.map((data) => ({ providerReceipt: messageReceipt(data) })),
        );
      }
      case "message.reply": {
        if (!isId(input.messageId, "om_")) {
          return fail("Feishu message.reply requires a messageId (om_…)");
        }
        if (
          input.inThread !== undefined &&
          typeof input.inThread !== "boolean"
        ) {
          return fail("Feishu message.reply inThread must be a boolean");
        }
        const content = messageContent(operation, input);
        if (typeof content === "string") return fail(content);
        const messageId = input.messageId;
        const inThread = input.inThread === true;
        return feishuUuid(effect.idempotencyKey).pipe(
          Effect.flatMap((uuid) =>
            client.request({
              authority,
              method: "POST",
              path: `/im/v1/messages/${messageId}/reply`,
              body: {
                msg_type: content.msgType,
                content: content.content,
                ...(inThread ? { reply_in_thread: true } : {}),
                uuid,
              },
            }),
          ),
          Effect.map((data) => ({ providerReceipt: messageReceipt(data) })),
        );
      }
      case "reaction.add": {
        if (!isId(input.messageId, "om_") || !nonEmptyString(input.emoji)) {
          return fail(
            "Feishu reaction.add requires a messageId (om_…) and an emoji",
          );
        }
        if (!/^[A-Za-z0-9_]+$/.test(input.emoji)) {
          return fail("Feishu reaction.add emoji must be an emoji_type name");
        }
        return client
          .request({
            authority,
            method: "POST",
            path: `/im/v1/messages/${input.messageId}/reactions`,
            body: { reaction_type: { emoji_type: input.emoji } },
          })
          .pipe(
            Effect.map((data) => ({
              providerReceipt:
                isRecord(data) && nonEmptyString(data.reaction_id)
                  ? { reactionId: data.reaction_id }
                  : null,
            })),
          );
      }
      case "card.update": {
        if (!isId(input.messageId, "om_") || !isRecord(input.card)) {
          return fail(
            "Feishu card.update requires a messageId (om_…) and a card",
          );
        }
        const content = JSON.stringify(input.card);
        if (utf8Length(content) > MAX_CARD_BYTES) {
          return fail(
            `Feishu card.update card exceeds ${MAX_CARD_BYTES} bytes`,
          );
        }
        const messageId = input.messageId;
        return client
          .request({
            authority,
            method: "PATCH",
            path: `/im/v1/messages/${messageId}`,
            body: { content },
          })
          .pipe(Effect.as({ providerReceipt: { messageId } }));
      }
    }
  };

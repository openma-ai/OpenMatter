import type { JsonValue, WorkEvent } from "@openma/matter";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const sensitiveKeys = new Set([
  "access_token",
  "app_access_token",
  "app_secret",
  "app_ticket",
  "authorization",
  "client_secret",
  "encrypt",
  "encrypt_key",
  "refresh_token",
  "secret",
  "tenant_access_token",
  "token",
  "user_access_token",
]);

/**
 * Event envelopes are untrusted and carry the verification token in
 * `header.token`, and card callbacks carry a card update token. Recursively
 * remove credential-shaped keys before a snapshot can enter a durable log.
 */
export const withoutFeishuCredentials = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(withoutFeishuCredentials);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, nested]) =>
      sensitiveKeys.has(key.toLowerCase())
        ? []
        : [[key, withoutFeishuCredentials(nested as JsonValue)]],
    ),
  );
};

export const feishuSource = (input: {
  readonly authority: string;
  readonly chatId?: string;
  readonly threadId?: string;
  readonly messageId?: string;
}): WorkEvent["source"] => ({
  provider: "feishu",
  authority: input.authority,
  ...(input.chatId === undefined ? {} : { conversationId: input.chatId }),
  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
  ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
});

/** Feishu sends epoch milliseconds (or seconds) as numbers or strings. */
export const epochToIso = (value: unknown): string | undefined => {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : undefined;
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined;
  // Ten digits or fewer is seconds.
  const ms = n < 1e11 ? n * 1000 : n;
  return new Date(ms).toISOString();
};

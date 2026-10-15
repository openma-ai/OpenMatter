import type { JsonValue, WorkEvent } from "@openma/matter";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sensitiveKeys = new Set([
  "access_token",
  "authorization",
  "client_secret",
  "password",
  "private_key",
  "private_token",
  "runners_token",
  "secret",
  "secret_token",
  "token",
  "webhook_secret",
]);

/** Webhook payloads are untrusted. Recursively remove conventional credential
 * keys before a provider snapshot can enter the durable event log. */
export const withoutGitLabCredentials = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(withoutGitLabCredentials);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, nested]) =>
      sensitiveKeys.has(key.toLowerCase())
        ? []
        : [[key, withoutGitLabCredentials(nested as JsonValue)]],
    ),
  );
};

export const gitlabSource = (input: {
  readonly authority: string;
  readonly project?: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly uri?: string;
}): WorkEvent["source"] => ({
  provider: "gitlab",
  authority: input.authority,
  ...(input.project === undefined ? {} : { conversationId: input.project }),
  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
  ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
  ...(input.uri === undefined ? {} : { uri: input.uri }),
});

export const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** GitLab timestamps come as ISO 8601 or as `2026-08-23 08:00:00 UTC`. */
export const isoTimestamp = (
  ...values: readonly unknown[]
): string | undefined => {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const parsed = Date.parse(
      value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/, "$1T$2Z"),
    );
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
};

import type { JsonValue, WorkEvent } from "@openmatter/core";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sensitiveKeys = new Set([
  "access_token",
  "authorization",
  "client_secret",
  "password",
  "private_key",
  "secret",
  "token",
  "webhook_secret",
]);

/** GitHub should not put credentials in webhook payloads, but extension fields
 * are untrusted. Recursively remove conventional credential keys before a
 * provider snapshot can enter the durable event log. */
export const withoutGitHubCredentials = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(withoutGitHubCredentials);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, nested]) =>
      sensitiveKeys.has(key.toLowerCase())
        ? []
        : [[key, withoutGitHubCredentials(nested as JsonValue)]],
    ),
  );
};

export const githubSource = (input: {
  readonly installationId: string;
  readonly repository?: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly uri?: string;
}): WorkEvent["source"] => ({
  provider: "github",
  authority: input.installationId,
  ...(input.repository === undefined
    ? {}
    : { conversationId: input.repository }),
  ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
  ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
  ...(input.uri === undefined ? {} : { uri: input.uri }),
});

export const stringIdentifier = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0
    ? value
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : undefined;

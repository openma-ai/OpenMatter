import type { JsonValue, WorkEvent } from "@openmatter/core";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const withoutSlackCredentials = (value: JsonValue): JsonValue => {
  const snapshot = structuredClone(value);
  if (!isRecord(snapshot)) return snapshot;
  const mutable = snapshot as Record<string, JsonValue>;

  delete mutable.response_url;
  delete mutable.response_urls;
  delete mutable.token;
  delete mutable.bot_access_token;

  if (isRecord(mutable.interactivity)) {
    const interactor = mutable.interactivity.interactor;
    if (isRecord(interactor)) {
      delete (interactor as Record<string, JsonValue>).secret;
    }
  }
  return snapshot as JsonValue;
};

export const slackTimestamp = (value: string): string => {
  const numeric = Number(value);
  const milliseconds = value.includes(".")
    ? numeric * 1_000
    : /^\d{16}$/.test(value)
      ? numeric / 1_000
      : /^\d{13}$/.test(value)
        ? numeric
        : numeric * 1_000;
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Invalid Slack timestamp");
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid Slack timestamp");
  return date.toISOString();
};

export const slackOccurredAt = (
  envelope: Record<string, unknown>,
  event: Record<string, unknown>,
  fallback: string,
): string => {
  for (const candidate of [event.event_ts, event.ts]) {
    if (typeof candidate === "string") {
      try {
        return slackTimestamp(candidate);
      } catch {
        // Some Slack event families use a different timestamp field.
      }
    }
  }
  if (
    typeof envelope.event_time === "number" &&
    Number.isSafeInteger(envelope.event_time)
  ) {
    try {
      return slackTimestamp(String(envelope.event_time));
    } catch {
      // The receipt clock is the only safe fallback.
    }
  }
  return fallback;
};

export const slackSource = (
  authority: string,
  input: {
    readonly channelId?: string;
    readonly threadTs?: string;
    readonly messageTs?: string;
  } = {},
): WorkEvent["source"] => ({
  provider: "slack",
  authority,
  ...(input.channelId === undefined ? {} : { conversationId: input.channelId }),
  ...(input.threadTs === undefined ? {} : { threadId: input.threadTs }),
  ...(input.messageTs === undefined ? {} : { messageId: input.messageTs }),
});

export const promptFrom = (text: string, botUserId: string): string =>
  text
    .replace(new RegExp(`<@${botUserId}(?:\\|[^>]+)?>`, "g"), " ")
    .replace(/\s+/g, " ")
    .trim();

/** Resolve the installation whose credential is authorized to process input.
 * Slack Connect's source workspace is not necessarily that installation. */
export const slackAuthorityFrom = (input: unknown): string | undefined => {
  if (!isRecord(input)) return undefined;
  const view = isRecord(input.view) ? input.view : undefined;
  if (typeof view?.app_installed_team_id === "string") {
    return view.app_installed_team_id;
  }
  const firstAuthorization = Array.isArray(input.authorizations)
    ? input.authorizations[0]
    : undefined;
  if (
    isRecord(firstAuthorization) &&
    firstAuthorization.is_enterprise_install === true &&
    typeof firstAuthorization.enterprise_id === "string"
  ) {
    return firstAuthorization.enterprise_id;
  }
  if (
    isRecord(firstAuthorization) &&
    typeof firstAuthorization.team_id === "string"
  ) {
    return firstAuthorization.team_id;
  }
  if (typeof input.team_id === "string") return input.team_id;
  if (typeof input.team === "string") return input.team;
  if (isRecord(input.team) && typeof input.team.id === "string") {
    return input.team.id;
  }
  if (isRecord(input.user) && typeof input.user.team_id === "string") {
    return input.user.team_id;
  }
  return typeof view?.team_id === "string" ? view.team_id : undefined;
};

/** Resolve the workspace perspective of Slack resources separately from the
 * installation whose token authorizes the event. */
export const slackContextTeamIdFrom = (
  input: unknown,
  authority: string | undefined,
): string | undefined => {
  if (!isRecord(input)) return undefined;
  if (typeof input.context_team_id === "string") {
    return input.context_team_id;
  }
  if (typeof input.client_context_team_id === "string") {
    return input.client_context_team_id;
  }
  if (typeof input.team_id === "string") return input.team_id;
  if (typeof input.team === "string") return input.team;
  if (isRecord(input.team) && typeof input.team.id === "string") {
    return input.team.id;
  }
  if (isRecord(input.user) && typeof input.user.team_id === "string") {
    return input.user.team_id;
  }
  const view = isRecord(input.view) ? input.view : undefined;
  if (typeof view?.team_id === "string") return view.team_id;
  return authority?.startsWith("T") ? authority : undefined;
};

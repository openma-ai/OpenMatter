import {
  JsonValueSchema,
  type JsonValue,
  type SourceAnchor,
  type WorkEvent,
} from "@openmatter/core";
import { Schema } from "effect";
import type { LinearWebhookInput } from "./http.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordAt = (
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  const candidate = value[key];
  return isRecord(candidate) ? candidate : undefined;
};

const stringAt = (
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const candidate = value?.[key];
  return typeof candidate === "string" ? candidate : undefined;
};

const actorSummary = (
  actor: Record<string, unknown> | undefined,
): JsonValue | undefined => {
  if (actor === undefined) return undefined;
  const id = stringAt(actor, "id");
  const name = stringAt(actor, "name");
  return id === undefined && name === undefined
    ? undefined
    : {
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name }),
      };
};

const parentResource = (input: {
  readonly resourceType: string;
  readonly resourceId: string | undefined;
  readonly resourceKey: string | undefined;
}): Record<string, JsonValue> =>
  input.resourceId === undefined
    ? {}
    : {
        parentResourceType: input.resourceType,
        parentResourceId: input.resourceId,
        ...(input.resourceKey === undefined
          ? {}
          : { parentResourceKey: input.resourceKey }),
      };

const parentResourceFor = (
  resourceType: string,
  data: Record<string, unknown> | undefined,
): Record<string, JsonValue> => {
  if (data === undefined) return {};
  if (resourceType === "Issue") {
    const project = recordAt(data, "project");
    return parentResource({
      resourceType: "project",
      resourceId: stringAt(data, "projectId") ?? stringAt(project, "id"),
      resourceKey:
        stringAt(project, "identifier") ?? stringAt(project, "slugId"),
    });
  }
  if (resourceType === "Comment") {
    const issue = recordAt(data, "issue");
    return parentResource({
      resourceType: "issue",
      resourceId: stringAt(data, "issueId") ?? stringAt(issue, "id"),
      resourceKey:
        stringAt(data, "issueIdentifier") ?? stringAt(issue, "identifier"),
    });
  }
  if (resourceType === "Document") {
    const project = recordAt(data, "project");
    return parentResource({
      resourceType: "project",
      resourceId: stringAt(data, "projectId") ?? stringAt(project, "id"),
      resourceKey:
        stringAt(project, "identifier") ?? stringAt(project, "slugId"),
    });
  }
  return {};
};

const credentialKeys = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "password",
  "refreshtoken",
  "secret",
  "signingsecret",
  "token",
  "webhooksecret",
]);

const withoutCredentials = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(withoutCredentials);
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (credentialKeys.has(key.replace(/[-_]/g, "").toLowerCase())) continue;
    result[key] = withoutCredentials(child);
  }
  return result;
};

const knownResourceTypes = new Set(["Issue", "Comment", "Project", "Document"]);

const actionSuffix: Readonly<Record<string, string>> = {
  create: "created",
  update: "updated",
  remove: "removed",
};

const sourceFor = (input: {
  readonly organizationId: string;
  readonly resourceType: string;
  readonly resourceId?: string;
  readonly data?: Record<string, unknown>;
  readonly uri?: string;
}): SourceAnchor => {
  const data = input.data;
  const parentId =
    data === undefined
      ? undefined
      : typeof data.issueId === "string"
        ? data.issueId
        : typeof data.projectId === "string"
          ? data.projectId
          : typeof data.documentContentId === "string"
            ? data.documentContentId
            : typeof data.projectUpdateId === "string"
              ? data.projectUpdateId
              : undefined;
  const conversationId =
    input.resourceType === "Project" ? input.resourceId : parentId;
  const threadId =
    input.resourceType === "Comment"
      ? (parentId ?? input.resourceId)
      : input.resourceId;
  return {
    provider: "linear",
    authority: input.organizationId,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(input.resourceType === "Comment" && input.resourceId !== undefined
      ? { messageId: input.resourceId }
      : {}),
    ...(input.uri === undefined ? {} : { uri: input.uri }),
  };
};

const deepFreeze = <Value>(value: Value): Value => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
};

export const normalizeLinearEvents = (
  input: unknown,
  clock: () => string,
): readonly WorkEvent[] => {
  if (
    !isRecord(input) ||
    input.kind !== "linear.webhook" ||
    typeof input.deliveryId !== "string" ||
    input.deliveryId.length === 0 ||
    typeof input.eventName !== "string" ||
    typeof input.timestamp !== "string" ||
    !isRecord(input.payload) ||
    !Schema.is(JsonValueSchema)(input.payload)
  ) {
    return [];
  }
  const envelope = input as unknown as LinearWebhookInput;
  const native = input.payload;
  if (
    typeof native.type !== "string" ||
    typeof native.action !== "string" ||
    typeof native.organizationId !== "string" ||
    typeof native.createdAt !== "string"
  ) {
    return [];
  }
  const makeEvent = (input: {
    readonly type: string;
    readonly source: SourceAnchor;
    readonly payload: Record<string, JsonValue>;
  }): readonly WorkEvent[] => [
    deepFreeze({
      schemaVersion: "0.1",
      id: `linear:${envelope.deliveryId}`,
      type: input.type,
      occurredAt: native.createdAt as string,
      receivedAt: clock(),
      idempotencyKey: `linear:${envelope.deliveryId}`,
      source: input.source,
      payload: input.payload,
      raw: withoutCredentials(structuredClone(native) as JsonValue),
      extensions: {
        deliveryId: envelope.deliveryId,
        eventName: envelope.eventName,
        deliveryTimestamp: envelope.timestamp,
      },
    }),
  ];

  if (native.type === "AppUserNotification") {
    const notification = isRecord(native.notification)
      ? native.notification
      : isRecord(native.data)
        ? native.data
        : {};
    const issue = recordAt(notification, "issue");
    const comment = recordAt(notification, "comment");
    const actor = recordAt(notification, "actor");
    const subtype = stringAt(notification, "type") ?? native.action;
    const semantics: Readonly<
      Record<string, { readonly type: string; readonly activation: string }>
    > = {
      issueAssignedToYou: {
        type: "linear.issue.assigned-to-agent",
        activation: "assignment",
      },
      issueMention: {
        type: "linear.issue.mentioned",
        activation: "mention",
      },
      issueCommentMention: {
        type: "linear.comment.mentioned",
        activation: "mention",
      },
      issueNewComment: {
        type: "linear.issue.comment-received",
        activation: "notification",
      },
    };
    const semantic = semantics[subtype];
    const issueId = stringAt(issue, "id");
    const commentId = stringAt(comment, "id");
    const resourceIsComment =
      subtype === "issueCommentMention" || subtype === "issueNewComment";
    const resourceId = resourceIsComment ? commentId : issueId;
    const issueKey = stringAt(issue, "identifier");
    const normalizedActor = actorSummary(actor);
    return makeEvent({
      type: semantic?.type ?? "linear.event.received",
      source: {
        provider: "linear",
        authority: native.organizationId,
        ...(issueId === undefined ? {} : { threadId: issueId }),
        ...(commentId === undefined ? {} : { messageId: commentId }),
        ...(typeof native.url === "string" ? { uri: native.url } : {}),
      },
      payload: {
        activation: semantic?.activation ?? "observation",
        organizationId: native.organizationId,
        resourceType: resourceIsComment ? "comment" : "issue",
        ...(resourceId === undefined ? {} : { resourceId }),
        ...(resourceIsComment
          ? parentResource({
              resourceType: "issue",
              resourceId: issueId,
              resourceKey: issueKey,
            })
          : issueKey === undefined
            ? {}
            : { resourceKey: issueKey }),
        action: subtype,
        notificationType: subtype,
        ...(issueId === undefined ? {} : { issueId }),
        ...(commentId === undefined ? {} : { commentId }),
        ...(normalizedActor === undefined ? {} : { actor: normalizedActor }),
      },
    });
  }

  if (native.type === "AgentSessionEvent") {
    const fromData = isRecord(native.data)
      ? recordAt(native.data, "agentSession")
      : undefined;
    const agentSession = isRecord(native.agentSession)
      ? native.agentSession
      : (fromData ?? {});
    const issue = recordAt(agentSession, "issue");
    const comment = recordAt(agentSession, "comment");
    const creator = recordAt(agentSession, "creator");
    const agentSessionId = stringAt(agentSession, "id");
    const issueId = stringAt(issue, "id") ?? stringAt(agentSession, "issueId");
    const commentId =
      stringAt(comment, "id") ?? stringAt(agentSession, "commentId");
    const issueKey = stringAt(issue, "identifier");
    const normalizedActor = actorSummary(creator);
    const type =
      native.action === "created"
        ? "linear.agent-session.created"
        : native.action === "prompted"
          ? "linear.agent-session.prompted"
          : "linear.event.received";
    return makeEvent({
      type,
      source: {
        provider: "linear",
        authority: native.organizationId,
        ...(issueId === undefined ? {} : { threadId: issueId }),
        ...(commentId === undefined ? {} : { messageId: commentId }),
        ...(typeof native.url === "string" ? { uri: native.url } : {}),
      },
      payload: {
        activation: type === "linear.event.received" ? "observation" : "direct",
        organizationId: native.organizationId,
        resourceType: "agent_session",
        ...(agentSessionId === undefined ? {} : { resourceId: agentSessionId }),
        ...parentResource({
          resourceType: "issue",
          resourceId: issueId,
          resourceKey: issueKey,
        }),
        action: native.action,
        ...(normalizedActor === undefined ? {} : { actor: normalizedActor }),
        ...(agentSessionId === undefined ? {} : { agentSessionId }),
        ...(issueId === undefined ? {} : { issueId }),
        ...(commentId === undefined ? {} : { commentId }),
        ...(typeof native.promptContext === "string"
          ? { promptContext: native.promptContext }
          : {}),
      },
    });
  }
  const data = isRecord(native.data) ? native.data : undefined;
  const resourceId =
    data !== undefined && typeof data.id === "string" ? data.id : undefined;
  const suffix = actionSuffix[native.action];
  const semantic = knownResourceTypes.has(native.type) && suffix !== undefined;
  if (semantic && resourceId === undefined) return [];

  const payload: Record<string, JsonValue> = {
    activation: "observation",
    organizationId: native.organizationId,
    resourceType: semantic ? native.type.toLowerCase() : "event",
    ...(resourceId === undefined ? {} : { resourceId }),
    ...(data !== undefined && typeof data.identifier === "string"
      ? { resourceKey: data.identifier }
      : {}),
    ...parentResourceFor(native.type, data),
    action: native.action,
  };
  const normalizedActor = actorSummary(
    isRecord(native.actor) ? native.actor : undefined,
  );
  if (normalizedActor !== undefined) payload.actor = normalizedActor;
  if (native.type === "Comment" && native.action === "create" && data) {
    const parent = recordAt(data, "parent");
    const parentCommentId =
      stringAt(data, "parentId") ?? stringAt(parent, "id");
    if (parentCommentId !== undefined)
      payload.parentCommentId = parentCommentId;
  }
  return makeEvent({
    type: semantic
      ? `linear.${native.type.toLowerCase()}.${suffix}`
      : "linear.event.received",
    source: sourceFor({
      organizationId: native.organizationId,
      resourceType: native.type,
      ...(resourceId === undefined ? {} : { resourceId }),
      ...(data === undefined ? {} : { data }),
      ...(typeof native.url === "string" ? { uri: native.url } : {}),
    }),
    payload,
  });
};

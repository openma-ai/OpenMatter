import {
  JsonValueSchema,
  markdownImages,
  messageImagesField,
  type JsonValue,
  type WorkEvent,
} from "@openma/matter";
import { IntegrationError } from "@openma/matter/integration";
import { Effect, Schema } from "effect";
import type { GitLabWebhookInput } from "./http.js";
import {
  gitlabSource,
  isRecord,
  isoTimestamp,
  nonEmptyString,
  positiveInteger,
  withoutGitLabCredentials,
} from "./shared.js";

const MERGE_REQUEST_ACTIONS: Readonly<Record<string, string>> = {
  open: "opened",
  reopen: "reopened",
  update: "updated",
  close: "closed",
  merge: "merged",
  approved: "approved",
  unapproved: "unapproved",
  approval: "approval_added",
  unapproval: "approval_removed",
};

const NOTEABLE_KINDS: Readonly<Record<string, string>> = {
  MergeRequest: "merge_request",
  Issue: "issue",
  Commit: "commit",
  Snippet: "snippet",
};

const PIPELINE_STATUSES = [
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
  "success",
  "failed",
  "canceled",
  "skipped",
  "manual",
  "scheduled",
] as const;

/** Every Event type `ingest` can produce. */
export const GITLAB_EVENT_TYPES: readonly string[] = [
  ...Object.values(MERGE_REQUEST_ACTIONS).map(
    (action) => `gitlab.merge_request.${action}`,
  ),
  ...Object.values(NOTEABLE_KINDS).flatMap((kind) => [
    `gitlab.${kind}.note.created`,
    `gitlab.${kind}.note.updated`,
  ]),
  ...PIPELINE_STATUSES.map((status) => `gitlab.pipeline.${status}`),
  "gitlab.event.received",
];

type Fields = Record<string, JsonValue>;

interface Normalized {
  readonly type: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly uri?: string;
  readonly occurredAt?: string;
  readonly fields: Fields;
}

const optional = (key: string, value: JsonValue | undefined): Fields =>
  value === undefined ? {} : { [key]: value };

const mergeRequest = (attributes: Record<string, unknown>): Normalized => {
  const action =
    typeof attributes.action === "string"
      ? MERGE_REQUEST_ACTIONS[attributes.action]
      : undefined;
  const iid = positiveInteger(attributes.iid) ? attributes.iid : undefined;
  const lastCommit = isRecord(attributes.last_commit)
    ? attributes.last_commit
    : undefined;
  const draft =
    typeof attributes.draft === "boolean"
      ? attributes.draft
      : typeof attributes.work_in_progress === "boolean"
        ? attributes.work_in_progress
        : undefined;
  const uri = nonEmptyString(attributes.url) ? attributes.url : undefined;
  const occurredAt = isoTimestamp(attributes.updated_at, attributes.created_at);
  return {
    type:
      action === undefined
        ? "gitlab.event.received"
        : `gitlab.merge_request.${action}`,
    ...(iid === undefined ? {} : { threadId: `merge_request:${iid}` }),
    ...(uri === undefined ? {} : { uri }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    fields: {
      resourceType: "merge_request",
      ...optional("mergeRequestIid", iid),
      ...optional(
        "title",
        typeof attributes.title === "string" ? attributes.title : undefined,
      ),
      ...optional("draft", draft),
      ...optional(
        "state",
        typeof attributes.state === "string" ? attributes.state : undefined,
      ),
      ...optional(
        "sourceBranch",
        nonEmptyString(attributes.source_branch)
          ? attributes.source_branch
          : undefined,
      ),
      ...optional(
        "targetBranch",
        nonEmptyString(attributes.target_branch)
          ? attributes.target_branch
          : undefined,
      ),
      ...optional(
        "headSha",
        nonEmptyString(lastCommit?.id) ? lastCommit.id : undefined,
      ),
      // GitLab sets `oldrev` on an update only when commits were pushed.
      newCommits:
        attributes.action === "open" ||
        attributes.action === "reopen" ||
        (attributes.action === "update" && nonEmptyString(attributes.oldrev)),
    },
  };
};

/**
 * The images of a note. GitLab writes uploads as `/uploads/<secret>/<file>`,
 * relative to the project, so those are resolved against its `web_url`.
 */
const noteImages = (text: string, payload: Record<string, unknown>) => {
  const project = isRecord(payload.project) ? payload.project : undefined;
  const base = nonEmptyString(project?.web_url)
    ? project.web_url.replace(/\/+$/, "")
    : undefined;
  return markdownImages(text).map((image) =>
    base !== undefined && image.id.startsWith("/uploads/")
      ? { ...image, id: `${base}${image.id}` }
      : image,
  );
};

const note = (
  attributes: Record<string, unknown>,
  payload: Record<string, unknown>,
): Normalized => {
  const kind =
    typeof attributes.noteable_type === "string"
      ? NOTEABLE_KINDS[attributes.noteable_type]
      : undefined;
  // GitLab before 16.x sends no `action`; every such delivery is a creation.
  const action =
    attributes.action === undefined || attributes.action === "create"
      ? "created"
      : attributes.action === "update"
        ? "updated"
        : undefined;
  const parent =
    kind === "merge_request"
      ? payload.merge_request
      : kind === "issue"
        ? payload.issue
        : kind === "commit"
          ? payload.commit
          : kind === "snippet"
            ? payload.snippet
            : undefined;
  const parentRecord = isRecord(parent) ? parent : undefined;
  const parentIid = positiveInteger(parentRecord?.iid)
    ? parentRecord.iid
    : undefined;
  const threadId =
    kind === "merge_request" || kind === "issue"
      ? parentIid === undefined
        ? undefined
        : `${kind}:${parentIid}`
      : kind === "commit"
        ? nonEmptyString(parentRecord?.id)
          ? `commit:${parentRecord.id}`
          : undefined
        : kind === "snippet" && positiveInteger(parentRecord?.id)
          ? `snippet:${parentRecord.id}`
          : undefined;
  const noteId = positiveInteger(attributes.id) ? attributes.id : undefined;
  const uri = nonEmptyString(attributes.url) ? attributes.url : undefined;
  const occurredAt = isoTimestamp(attributes.updated_at, attributes.created_at);
  return {
    type:
      kind === undefined || action === undefined
        ? "gitlab.event.received"
        : `gitlab.${kind}.note.${action}`,
    ...(threadId === undefined ? {} : { threadId }),
    ...(noteId === undefined ? {} : { messageId: `note:${noteId}` }),
    ...(uri === undefined ? {} : { uri }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    fields: {
      resourceType: "note",
      ...optional("noteId", noteId),
      ...optional(
        "text",
        typeof attributes.note === "string" ? attributes.note : undefined,
      ),
      ...optional(
        "discussionId",
        nonEmptyString(attributes.discussion_id)
          ? attributes.discussion_id
          : undefined,
      ),
      ...optional(
        "noteableType",
        typeof attributes.noteable_type === "string"
          ? attributes.noteable_type
          : undefined,
      ),
      ...optional(
        kind === "issue" ? "issueIid" : "mergeRequestIid",
        kind === "merge_request" || kind === "issue" ? parentIid : undefined,
      ),
      ...optional(
        "draft",
        kind === "merge_request" && typeof parentRecord?.draft === "boolean"
          ? parentRecord.draft
          : undefined,
      ),
      system: attributes.system === true,
      ...messageImagesField(
        typeof attributes.note === "string"
          ? noteImages(attributes.note, payload)
          : [],
      ),
    },
  };
};

const pipeline = (
  attributes: Record<string, unknown>,
  payload: Record<string, unknown>,
): Normalized => {
  const status = PIPELINE_STATUSES.find(
    (candidate) => candidate === attributes.status,
  );
  const id = positiveInteger(attributes.id) ? attributes.id : undefined;
  const mergeRequestIid =
    isRecord(payload.merge_request) &&
    positiveInteger(payload.merge_request.iid)
      ? payload.merge_request.iid
      : undefined;
  const uri = nonEmptyString(attributes.url) ? attributes.url : undefined;
  const occurredAt = isoTimestamp(
    attributes.finished_at,
    attributes.created_at,
  );
  return {
    type:
      status === undefined
        ? "gitlab.event.received"
        : `gitlab.pipeline.${status}`,
    // A merge request pipeline joins the merge request's thread.
    ...(mergeRequestIid !== undefined
      ? { threadId: `merge_request:${mergeRequestIid}` }
      : id === undefined
        ? {}
        : { threadId: `pipeline:${id}` }),
    ...(id === undefined || status === undefined
      ? {}
      : { messageId: `pipeline:${id}:${status}` }),
    ...(uri === undefined ? {} : { uri }),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    fields: {
      resourceType: "pipeline",
      ...optional("pipelineId", id),
      ...optional("status", status),
      ...optional(
        "ref",
        nonEmptyString(attributes.ref) ? attributes.ref : undefined,
      ),
      ...optional(
        "sha",
        nonEmptyString(attributes.sha) ? attributes.sha : undefined,
      ),
      ...optional("mergeRequestIid", mergeRequestIid),
    },
  };
};

const normalize = (payload: Record<string, unknown>): Normalized => {
  const attributes = isRecord(payload.object_attributes)
    ? payload.object_attributes
    : undefined;
  if (attributes !== undefined) {
    if (payload.object_kind === "merge_request")
      return mergeRequest(attributes);
    if (payload.object_kind === "note") return note(attributes, payload);
    if (payload.object_kind === "pipeline")
      return pipeline(attributes, payload);
  }
  return { type: "gitlab.event.received", fields: {} };
};

/**
 * Turns a verified `GitLabWebhookInput` into one WorkEvent. Inputs of another
 * kind produce no Events. The Event id combines the authority and the
 * delivery id, so a GitLab retry is the same Event.
 */
export const normalizeGitLabEvents = (
  input: unknown,
  clock: () => string,
): Effect.Effect<readonly WorkEvent[], IntegrationError> =>
  Effect.try({
    try: () => {
      if (
        !isRecord(input) ||
        input.kind !== "gitlab.webhook" ||
        !nonEmptyString(input.authority) ||
        !nonEmptyString(input.eventName) ||
        !nonEmptyString(input.deliveryId) ||
        !isRecord(input.payload) ||
        !Schema.is(JsonValueSchema)(input.payload)
      ) {
        return [];
      }
      const webhook = input as unknown as GitLabWebhookInput;
      const payload = webhook.payload as Record<string, unknown>;
      const project = isRecord(payload.project) ? payload.project : undefined;
      const projectId = positiveInteger(project?.id)
        ? project.id
        : positiveInteger(payload.project_id)
          ? payload.project_id
          : undefined;
      const projectPath = nonEmptyString(project?.path_with_namespace)
        ? project.path_with_namespace
        : undefined;
      const user = isRecord(payload.user) ? payload.user : undefined;
      const actor: Fields = {
        ...optional(
          "id",
          positiveInteger(user?.id) ? String(user.id) : undefined,
        ),
        ...optional(
          "username",
          nonEmptyString(user?.username) ? user.username : undefined,
        ),
        ...optional("name", nonEmptyString(user?.name) ? user.name : undefined),
      };
      const normalized = normalize(payload);
      const receivedAt = clock();
      const id = `gitlab:${webhook.authority}:${webhook.deliveryId}`;
      const event: WorkEvent = {
        schemaVersion: "0.1",
        id,
        type: normalized.type,
        occurredAt: normalized.occurredAt ?? receivedAt,
        receivedAt,
        idempotencyKey: id,
        source: gitlabSource({
          authority: webhook.authority,
          ...(projectPath === undefined ? {} : { project: projectPath }),
          ...(normalized.threadId === undefined
            ? {}
            : { threadId: normalized.threadId }),
          ...(normalized.messageId === undefined
            ? {}
            : { messageId: normalized.messageId }),
          ...(normalized.uri === undefined ? {} : { uri: normalized.uri }),
        }),
        payload: {
          activation: "observation",
          eventName: webhook.eventName,
          ...optional(
            "objectKind",
            nonEmptyString(payload.object_kind)
              ? payload.object_kind
              : undefined,
          ),
          authority: webhook.authority,
          ...optional("instance", webhook.instance),
          ...optional("projectId", projectId),
          ...optional("project", projectPath),
          // The Bond resource id, so a Loop can match its configured projects.
          ...optional(
            "resource",
            projectId === undefined ? undefined : `project:${projectId}`,
          ),
          ...normalized.fields,
          ...(Object.keys(actor).length === 0 ? {} : { actor }),
        },
        raw: withoutGitLabCredentials(webhook.payload),
      };
      return [event];
    },
    catch: (cause) =>
      new IntegrationError({
        message: "Unable to normalize GitLab webhook",
        retryable: false,
        cause,
      }),
  });

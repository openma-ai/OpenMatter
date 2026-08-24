import {
  JsonValueSchema,
  type JsonValue,
  type WorkEvent,
} from "@openmatter/core";
import { IntegrationError } from "@openmatter/integration";
import { Effect, Schema } from "effect";
import type { GitHubWebhookInput } from "./http.js";
import {
  githubSource,
  isRecord,
  stringIdentifier,
  withoutGitHubCredentials,
} from "./shared.js";

interface ResourceIdentity {
  readonly kind: string;
  readonly id?: string | number;
  readonly number?: number;
  readonly parentKind?: string;
  readonly parentId?: string | number;
  readonly parentNumber?: number;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly uri?: string;
  readonly occurredAt?: string;
}

const timestampFrom = (...values: readonly unknown[]): string | undefined =>
  values.find(
    (value): value is string =>
      typeof value === "string" && Number.isFinite(Date.parse(value)),
  );

const resourceIdentity = (
  eventName: string,
  payload: Record<string, unknown>,
): ResourceIdentity => {
  const issue = isRecord(payload.issue) ? payload.issue : undefined;
  const pullRequest = isRecord(payload.pull_request)
    ? payload.pull_request
    : undefined;
  const comment = isRecord(payload.comment) ? payload.comment : undefined;
  const review = isRecord(payload.review) ? payload.review : undefined;
  const workflowRun = isRecord(payload.workflow_run)
    ? payload.workflow_run
    : undefined;
  const installation = isRecord(payload.installation)
    ? payload.installation
    : undefined;
  const installationId = stringIdentifier(installation?.id);
  const issueNumber =
    typeof issue?.number === "number" && Number.isSafeInteger(issue.number)
      ? issue.number
      : undefined;
  const pullNumber =
    typeof pullRequest?.number === "number" &&
    Number.isSafeInteger(pullRequest.number)
      ? pullRequest.number
      : undefined;

  if (
    (eventName === "installation" ||
      eventName === "installation_repositories") &&
    installationId !== undefined
  ) {
    return {
      kind: "installation",
      id: installationId,
    };
  }

  if (eventName === "issues" && issue !== undefined) {
    const occurredAt = timestampFrom(issue.updated_at, issue.created_at);
    return {
      kind: "issue",
      ...(stringIdentifier(issue.id) === undefined
        ? {}
        : { id: issue.id as string | number }),
      ...(issueNumber === undefined
        ? {}
        : { number: issueNumber, threadId: `issue:${issueNumber}` }),
      ...(typeof issue.html_url === "string" ? { uri: issue.html_url } : {}),
      ...(occurredAt === undefined ? {} : { occurredAt }),
    };
  }
  if (eventName === "issue_comment" && issue !== undefined) {
    const isPullRequest = isRecord(issue.pull_request);
    const parentId = stringIdentifier(issue.id);
    const occurredAt = timestampFrom(
      comment?.updated_at,
      comment?.created_at,
      issue.updated_at,
    );
    return {
      kind: "comment",
      ...(stringIdentifier(comment?.id) === undefined
        ? {}
        : { id: comment?.id as string | number }),
      parentKind: isPullRequest ? "pull_request" : "issue",
      ...(parentId === undefined
        ? {}
        : { parentId: issue.id as string | number }),
      ...(issueNumber === undefined
        ? {}
        : {
            parentNumber: issueNumber,
            threadId: `${isPullRequest ? "pull_request" : "issue"}:${issueNumber}`,
          }),
      ...(stringIdentifier(comment?.id) === undefined
        ? {}
        : { messageId: `issue_comment:${stringIdentifier(comment?.id)}` }),
      ...(typeof comment?.html_url === "string"
        ? { uri: comment.html_url }
        : typeof issue.html_url === "string"
          ? { uri: issue.html_url }
          : {}),
      ...(occurredAt === undefined ? {} : { occurredAt }),
    };
  }
  if (eventName === "pull_request" && pullRequest !== undefined) {
    const occurredAt = timestampFrom(
      pullRequest.updated_at,
      pullRequest.created_at,
    );
    return {
      kind: "pull_request",
      ...(stringIdentifier(pullRequest.id) === undefined
        ? {}
        : { id: pullRequest.id as string | number }),
      ...(pullNumber === undefined
        ? {}
        : { number: pullNumber, threadId: `pull_request:${pullNumber}` }),
      ...(typeof pullRequest.html_url === "string"
        ? { uri: pullRequest.html_url }
        : {}),
      ...(occurredAt === undefined ? {} : { occurredAt }),
    };
  }
  if (
    (eventName === "pull_request_review" ||
      eventName === "pull_request_review_comment") &&
    pullRequest !== undefined
  ) {
    const reviewId = stringIdentifier(review?.id);
    const commentId = stringIdentifier(comment?.id);
    const occurredAt = timestampFrom(
      review?.submitted_at,
      comment?.updated_at,
      comment?.created_at,
      pullRequest.updated_at,
    );
    const parentId = stringIdentifier(pullRequest.id);
    return {
      kind: eventName === "pull_request_review" ? "review" : "comment",
      ...(eventName === "pull_request_review" && reviewId !== undefined
        ? { id: review?.id as string | number, messageId: `review:${reviewId}` }
        : eventName === "pull_request_review_comment" && commentId !== undefined
          ? {
              id: comment?.id as string | number,
              messageId: `review_comment:${commentId}`,
            }
          : {}),
      parentKind: "pull_request",
      ...(parentId === undefined
        ? {}
        : { parentId: pullRequest.id as string | number }),
      ...(pullNumber === undefined
        ? {}
        : {
            parentNumber: pullNumber,
            threadId: `pull_request:${pullNumber}`,
          }),
      ...(eventName === "pull_request_review" &&
      typeof review?.html_url === "string"
        ? { uri: review.html_url }
        : eventName === "pull_request_review_comment" &&
            typeof comment?.html_url === "string"
          ? { uri: comment.html_url }
          : typeof pullRequest.html_url === "string"
            ? { uri: pullRequest.html_url }
            : {}),
      ...(occurredAt === undefined ? {} : { occurredAt }),
    };
  }
  if (eventName === "workflow_run" && workflowRun !== undefined) {
    const runId = stringIdentifier(workflowRun.id);
    const occurredAt = timestampFrom(
      workflowRun.updated_at,
      workflowRun.run_started_at,
      workflowRun.created_at,
    );
    return {
      kind: "workflow_run",
      ...(runId === undefined
        ? {}
        : {
            id: workflowRun.id as string | number,
            threadId: `workflow_run:${runId}`,
          }),
      ...(typeof workflowRun.html_url === "string"
        ? { uri: workflowRun.html_url }
        : {}),
      ...(occurredAt === undefined ? {} : { occurredAt }),
    };
  }
  return { kind: "event" };
};

const semanticType = (
  eventName: string,
  action: string,
  resource: ResourceIdentity,
): string => {
  if (eventName === "issues") return `github.issue.${action}`;
  if (eventName === "issue_comment") {
    return resource.parentKind === "pull_request"
      ? `github.pull_request.comment.${action}`
      : `github.issue.comment.${action}`;
  }
  if (eventName === "pull_request") return `github.pull_request.${action}`;
  if (eventName === "pull_request_review") {
    return `github.pull_request.review.${action}`;
  }
  if (eventName === "pull_request_review_comment") {
    return `github.pull_request.review_comment.${action}`;
  }
  if (eventName === "workflow_run") return `github.workflow_run.${action}`;
  if (eventName === "installation") return `github.installation.${action}`;
  if (eventName === "installation_repositories") {
    return `github.installation.repositories.${action}`;
  }
  return "github.event.received";
};

export const normalizeGitHubEvents = (
  input: unknown,
  clock: () => string,
): Effect.Effect<readonly WorkEvent[], IntegrationError> =>
  Effect.try({
    try: () => {
      if (
        !isRecord(input) ||
        input.kind !== "github.webhook" ||
        typeof input.eventName !== "string" ||
        typeof input.deliveryId !== "string" ||
        !isRecord(input.payload) ||
        !Schema.is(JsonValueSchema)(input.payload)
      ) {
        return [];
      }
      const webhook = input as unknown as GitHubWebhookInput;
      const payload = webhook.payload as Record<string, JsonValue>;
      const installation = isRecord(payload.installation)
        ? payload.installation
        : undefined;
      const installationId = stringIdentifier(installation?.id);
      if (installationId === undefined) return [];
      const repository = isRecord(payload.repository)
        ? payload.repository
        : undefined;
      const repositoryName =
        typeof repository?.full_name === "string"
          ? repository.full_name
          : undefined;
      const repositoryId =
        typeof repository?.id === "number" &&
        Number.isSafeInteger(repository.id)
          ? repository.id
          : typeof repository?.id === "string"
            ? repository.id
            : undefined;
      const action =
        typeof payload.action === "string" ? payload.action : "received";
      const sender = isRecord(payload.sender) ? payload.sender : undefined;
      const actorId = stringIdentifier(sender?.id);
      const actorName =
        typeof sender?.login === "string"
          ? sender.login
          : typeof sender?.name === "string"
            ? sender.name
            : undefined;
      const actor =
        actorId === undefined && actorName === undefined
          ? undefined
          : {
              ...(actorId === undefined ? {} : { id: actorId }),
              ...(actorName === undefined ? {} : { name: actorName }),
            };
      const resource = resourceIdentity(webhook.eventName, payload);
      const receivedAt = clock();
      const id = `github:${webhook.deliveryId}`;
      return [
        {
          schemaVersion: "0.1",
          id,
          type: semanticType(webhook.eventName, action, resource),
          occurredAt: resource.occurredAt ?? receivedAt,
          receivedAt,
          idempotencyKey: id,
          source: githubSource({
            installationId,
            ...(repositoryName === undefined
              ? {}
              : { repository: repositoryName }),
            ...(resource.threadId === undefined
              ? {}
              : { threadId: resource.threadId }),
            ...(resource.messageId === undefined
              ? {}
              : { messageId: resource.messageId }),
            ...(resource.uri === undefined ? {} : { uri: resource.uri }),
          }),
          payload: {
            activation: "observation",
            eventName: webhook.eventName,
            action,
            installationId,
            ...(repositoryId === undefined ? {} : { repositoryId }),
            ...(repositoryName === undefined
              ? {}
              : { repository: repositoryName }),
            resourceType: resource.kind,
            ...(resource.id === undefined ? {} : { resourceId: resource.id }),
            ...(resource.number === undefined
              ? {}
              : { resourceNumber: resource.number }),
            ...(repositoryName === undefined || resource.number === undefined
              ? {}
              : { resourceKey: `${repositoryName}#${resource.number}` }),
            ...(resource.parentKind === undefined
              ? {}
              : { parentResourceType: resource.parentKind }),
            ...(resource.parentId === undefined
              ? {}
              : { parentResourceId: resource.parentId }),
            ...(repositoryName === undefined ||
            resource.parentNumber === undefined
              ? {}
              : {
                  parentResourceKey: `${repositoryName}#${resource.parentNumber}`,
                }),
            ...(actor === undefined ? {} : { actor }),
          },
          raw: withoutGitHubCredentials(webhook.payload),
        },
      ] satisfies readonly WorkEvent[];
    },
    catch: (cause) =>
      new IntegrationError({
        message: "Unable to normalize GitHub webhook",
        retryable: false,
        cause,
      }),
  });

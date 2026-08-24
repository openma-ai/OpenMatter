import type { ContextItem, JsonValue } from "@openmatter/core";
import { IntegrationError } from "@openmatter/integration";
import { Effect } from "effect";
import type { LinearProviderClient } from "./provider-client.js";
import type { LinearContextReader } from "./types.js";

const isRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ISSUE_QUERY = `query OpenMatterLinearIssue($id: String!) {
  issue(id: $id) {
    id identifier title description priority estimate dueDate url createdAt updatedAt
    team { id key name }
    state { id name type }
    assignee { id name email }
    project { id name url }
    labels { nodes { id name color } }
  }
}`;

const ISSUE_COMMENTS_QUERY = `query OpenMatterLinearIssueComments($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    id identifier url
    comments(first: $first, after: $after) {
      nodes { id body createdAt updatedAt url parent { id } user { id name email } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const PROJECT_QUERY = `query OpenMatterLinearProject($id: String!) {
  project(id: $id) {
    id name description content icon color url startDate targetDate createdAt updatedAt
    status { id name type }
    lead { id name email }
    teams { nodes { id key name } }
  }
}`;

const DOCUMENT_QUERY = `query OpenMatterLinearDocument($id: String!) {
  document(id: $id) {
    id title content icon color url createdAt updatedAt
    project { id name url }
    creator { id name email }
  }
}`;

const item = (input: {
  readonly id: string;
  readonly kind: string;
  readonly value: JsonValue;
  readonly sourceId: string;
  readonly uri?: string;
}): ContextItem => ({
  id: input.id,
  kind: input.kind,
  value: input.value,
  provenance: [
    {
      sourceType: "linear-api",
      sourceId: input.sourceId,
      integrationId: "linear",
      ...(input.uri === undefined ? {} : { uri: input.uri }),
    },
  ],
});

const resourceFrom = (
  data: Record<string, JsonValue>,
  field: "issue" | "project" | "document",
): Effect.Effect<Record<string, JsonValue>, IntegrationError> =>
  isRecord(data[field])
    ? Effect.succeed(structuredClone(data[field]))
    : Effect.fail(
        new IntegrationError({
          message: `Linear response is missing ${field}`,
          retryable: false,
        }),
      );

const invalidContextInput = (
  message: string,
): Effect.Effect<never, IntegrationError> =>
  Effect.fail(
    new IntegrationError({
      message,
      retryable: false,
    }),
  );

const validateResourceInput = (
  organizationId: string,
  resourceName: string,
  resourceId: string,
): Effect.Effect<void, IntegrationError> => {
  if (organizationId.trim().length === 0) {
    return invalidContextInput("Linear Context requires organizationId");
  }
  if (resourceId.trim().length === 0) {
    return invalidContextInput(`Linear Context requires ${resourceName}`);
  }
  return Effect.void;
};

const validateIssueCommentsInput = (input: {
  readonly organizationId: string;
  readonly issueId: string;
  readonly first?: number;
  readonly after?: string;
}): Effect.Effect<void, IntegrationError> => {
  const resource = validateResourceInput(
    input.organizationId,
    "issueId",
    input.issueId,
  );
  if (
    input.first !== undefined &&
    (!Number.isSafeInteger(input.first) || input.first < 1 || input.first > 250)
  ) {
    return invalidContextInput(
      "Linear issueComments first must be a safe integer from 1 to 250",
    );
  }
  if (input.after !== undefined && input.after.trim().length === 0) {
    return invalidContextInput(
      "Linear issueComments after must be a non-empty cursor",
    );
  }
  return resource;
};

export const makeLinearContextReader = (
  provider: LinearProviderClient,
): LinearContextReader => ({
  issue: (input) =>
    validateResourceInput(input.organizationId, "issueId", input.issueId).pipe(
      Effect.flatMap(() =>
        provider.execute(
          "OpenMatterLinearIssue",
          ISSUE_QUERY,
          { id: input.issueId },
          input.organizationId,
        ),
      ),
      Effect.flatMap((data) => resourceFrom(data, "issue")),
      Effect.map((issue) =>
        item({
          id: `linear:${input.organizationId}:issue:${input.issueId}`,
          kind: "linear.issue",
          value: { organizationId: input.organizationId, issue },
          sourceId: `${input.organizationId}:${input.issueId}`,
          ...(typeof issue.url === "string" ? { uri: issue.url } : {}),
        }),
      ),
    ),
  issueComments: (input) =>
    validateIssueCommentsInput(input).pipe(
      Effect.flatMap(() =>
        provider.execute(
          "OpenMatterLinearIssueComments",
          ISSUE_COMMENTS_QUERY,
          {
            id: input.issueId,
            first: input.first ?? 50,
            ...(input.after === undefined ? {} : { after: input.after }),
          },
          input.organizationId,
        ),
      ),
      Effect.flatMap((data) => resourceFrom(data, "issue")),
      Effect.flatMap((issue) => {
        const comments = issue.comments;
        if (!isRecord(comments) || !Array.isArray(comments.nodes)) {
          return Effect.fail(
            new IntegrationError({
              message: "Linear issue comments response is malformed",
              retryable: false,
            }),
          );
        }
        const pageInfo = isRecord(comments.pageInfo) ? comments.pageInfo : {};
        const nextCursor =
          typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : "";
        return Effect.succeed(
          item({
            id: `linear:${input.organizationId}:issue-comments:${input.issueId}`,
            kind: "linear.issue-comments",
            value: {
              organizationId: input.organizationId,
              issueId: input.issueId,
              comments: structuredClone(comments.nodes) as JsonValue,
              hasMore: pageInfo.hasNextPage === true,
              nextCursor,
            },
            sourceId: `${input.organizationId}:${input.issueId}:comments`,
            ...(typeof issue.url === "string" ? { uri: issue.url } : {}),
          }),
        );
      }),
    ),
  project: (input) =>
    validateResourceInput(
      input.organizationId,
      "projectId",
      input.projectId,
    ).pipe(
      Effect.flatMap(() =>
        provider.execute(
          "OpenMatterLinearProject",
          PROJECT_QUERY,
          { id: input.projectId },
          input.organizationId,
        ),
      ),
      Effect.flatMap((data) => resourceFrom(data, "project")),
      Effect.map((project) =>
        item({
          id: `linear:${input.organizationId}:project:${input.projectId}`,
          kind: "linear.project",
          value: { organizationId: input.organizationId, project },
          sourceId: `${input.organizationId}:${input.projectId}`,
          ...(typeof project.url === "string" ? { uri: project.url } : {}),
        }),
      ),
    ),
  document: (input) =>
    validateResourceInput(
      input.organizationId,
      "documentId",
      input.documentId,
    ).pipe(
      Effect.flatMap(() =>
        provider.execute(
          "OpenMatterLinearDocument",
          DOCUMENT_QUERY,
          { id: input.documentId },
          input.organizationId,
        ),
      ),
      Effect.flatMap((data) => resourceFrom(data, "document")),
      Effect.map((document) =>
        item({
          id: `linear:${input.organizationId}:document:${input.documentId}`,
          kind: "linear.document",
          value: { organizationId: input.organizationId, document },
          sourceId: `${input.organizationId}:${input.documentId}`,
          ...(typeof document.url === "string" ? { uri: document.url } : {}),
        }),
      ),
    ),
});

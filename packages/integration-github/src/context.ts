import type { ContextItem, JsonValue } from "@openmatter/core";
import { IntegrationError } from "@openmatter/integration";
import { Effect } from "effect";
import type { GitHubProviderClient } from "./provider-client.js";
import { isRecord } from "./shared.js";
import type { GitHubContextReader } from "./types.js";

const segment = (value: string): string => encodeURIComponent(value);

const pageFromLink = (
  link: string | null,
  relation: string,
): number | undefined => {
  if (link === null) return undefined;
  for (const entry of link.split(",")) {
    const match = entry.match(/<([^>]+)>\s*;\s*rel="([^"]+)"/);
    if (match?.[2] !== relation || match[1] === undefined) continue;
    const page = Number.parseInt(
      new URL(match[1]).searchParams.get("page") ?? "",
      10,
    );
    if (Number.isSafeInteger(page) && page > 0) return page;
  }
  return undefined;
};

const contextItem = (input: {
  readonly id: string;
  readonly kind: string;
  readonly value: JsonValue;
  readonly sourceId: string;
  readonly uri: string;
}): ContextItem => ({
  id: input.id,
  kind: input.kind,
  value: input.value,
  provenance: [
    {
      sourceType: "github-rest",
      sourceId: input.sourceId,
      integrationId: "github",
      uri: input.uri,
    },
  ],
});

export const makeGitHubContextReader = (
  provider: Pick<GitHubProviderClient, "request">,
): GitHubContextReader => {
  const validateResource = (input: {
    readonly installationId: string;
    readonly owner: string;
    readonly repo: string;
  }): Effect.Effect<void, IntegrationError> =>
    input.installationId.length > 0 &&
    input.owner.length > 0 &&
    input.repo.length > 0
      ? Effect.void
      : Effect.fail(
          new IntegrationError({
            message: "GitHub context requires installationId, owner, and repo",
            retryable: false,
          }),
        );

  const validatePositive = (
    value: number,
    name: string,
  ): Effect.Effect<void, IntegrationError> =>
    Number.isSafeInteger(value) && value > 0
      ? Effect.void
      : Effect.fail(
          new IntegrationError({
            message: `GitHub context ${name} must be a positive integer`,
            retryable: false,
          }),
        );

  const validatePage = (
    page: number,
    limit: number,
  ): Effect.Effect<void, IntegrationError> =>
    Number.isSafeInteger(page) &&
    page > 0 &&
    Number.isSafeInteger(limit) &&
    limit > 0 &&
    limit <= 100
      ? Effect.void
      : Effect.fail(
          new IntegrationError({
            message:
              "GitHub context page must be positive and limit must be 1..100",
            retryable: false,
          }),
        );

  const single = (input: {
    readonly installationId: string;
    readonly owner: string;
    readonly repo: string;
    readonly path: string;
    readonly id: string;
    readonly kind: string;
    readonly valueKey: string;
    readonly sourceId: string;
    readonly uri: string;
  }): Effect.Effect<ContextItem, IntegrationError> =>
    validateResource(input).pipe(
      Effect.flatMap(() =>
        provider.request({
          installationId: input.installationId,
          method: "GET",
          path: input.path,
        }),
      ),
      Effect.flatMap(({ payload }) =>
        isRecord(payload)
          ? Effect.succeed(
              contextItem({
                id: input.id,
                kind: input.kind,
                value: {
                  installationId: input.installationId,
                  repository: `${input.owner}/${input.repo}`,
                  [input.valueKey]: payload as JsonValue,
                },
                sourceId: input.sourceId,
                uri: input.uri,
              }),
            )
          : Effect.fail(
              new IntegrationError({
                message: `GitHub ${input.kind} response must be an object`,
                retryable: false,
              }),
            ),
      ),
    );

  const readPage = (input: {
    readonly installationId: string;
    readonly owner: string;
    readonly repo: string;
    readonly path: string;
    readonly id: string;
    readonly kind: string;
    readonly sourceId: string;
    readonly uri: string;
    readonly page: number;
    readonly limit: number;
    readonly resource: Readonly<Record<string, JsonValue>>;
  }): Effect.Effect<ContextItem, IntegrationError> =>
    validateResource(input).pipe(
      Effect.zipRight(validatePage(input.page, input.limit)),
      Effect.flatMap(() =>
        provider.request({
          installationId: input.installationId,
          method: "GET",
          path: input.path,
          query: { per_page: input.limit, page: input.page },
        }),
      ),
      Effect.flatMap(({ payload, headers }) => {
        if (!Array.isArray(payload)) {
          return Effect.fail(
            new IntegrationError({
              message: `GitHub ${input.kind} response must be an array`,
              retryable: false,
            }),
          );
        }
        const nextPage = pageFromLink(headers.get("link"), "next");
        return Effect.succeed(
          contextItem({
            id: input.id,
            kind: input.kind,
            value: {
              installationId: input.installationId,
              repository: `${input.owner}/${input.repo}`,
              ...input.resource,
              items: payload,
              page: input.page,
              limit: input.limit,
              hasMore: nextPage !== undefined,
              ...(nextPage === undefined ? {} : { nextPage }),
            },
            sourceId: input.sourceId,
            uri: input.uri,
          }),
        );
      }),
    );

  return {
    repository: (input) => {
      const repository = `${input.owner}/${input.repo}`;
      return single({
        ...input,
        path: `/repos/${segment(input.owner)}/${segment(input.repo)}`,
        id: `github:${input.installationId}:repository:${repository}`,
        kind: "github.repository",
        valueKey: "repositoryData",
        sourceId: repository,
        uri: `https://github.com/${input.owner}/${input.repo}`,
      });
    },
    issue: (input) =>
      validatePositive(input.issueNumber, "issueNumber").pipe(
        Effect.zipRight(
          single({
            ...input,
            path: `/repos/${segment(input.owner)}/${segment(input.repo)}/issues/${input.issueNumber}`,
            id: `github:${input.installationId}:issue:${input.owner}/${input.repo}:${input.issueNumber}`,
            kind: "github.issue",
            valueKey: "issue",
            sourceId: `${input.owner}/${input.repo}#${input.issueNumber}`,
            uri: `https://github.com/${input.owner}/${input.repo}/issues/${input.issueNumber}`,
          }),
        ),
      ),
    issueComments: (input) => {
      const currentPage = input.page ?? 1;
      const limit = input.limit ?? 30;
      const repository = `${input.owner}/${input.repo}`;
      return validatePositive(input.issueNumber, "issueNumber").pipe(
        Effect.zipRight(
          readPage({
            ...input,
            path: `/repos/${segment(input.owner)}/${segment(input.repo)}/issues/${input.issueNumber}/comments`,
            id: `github:${input.installationId}:issue-comments:${repository}:${input.issueNumber}:page:${currentPage}`,
            kind: "github.issue-comments",
            sourceId: `${repository}#${input.issueNumber}:comments:page:${currentPage}`,
            uri: `https://github.com/${input.owner}/${input.repo}/issues/${input.issueNumber}`,
            page: currentPage,
            limit,
            resource: { issueNumber: input.issueNumber },
          }),
        ),
      );
    },
    pullRequest: (input) =>
      validatePositive(input.pullNumber, "pullNumber").pipe(
        Effect.zipRight(
          single({
            ...input,
            path: `/repos/${segment(input.owner)}/${segment(input.repo)}/pulls/${input.pullNumber}`,
            id: `github:${input.installationId}:pull-request:${input.owner}/${input.repo}:${input.pullNumber}`,
            kind: "github.pull-request",
            valueKey: "pullRequest",
            sourceId: `${input.owner}/${input.repo}#${input.pullNumber}:pull-request`,
            uri: `https://github.com/${input.owner}/${input.repo}/pull/${input.pullNumber}`,
          }),
        ),
      ),
    pullRequestFiles: (input) => {
      const currentPage = input.page ?? 1;
      const limit = input.limit ?? 30;
      return validatePositive(input.pullNumber, "pullNumber").pipe(
        Effect.zipRight(
          readPage({
            ...input,
            path: `/repos/${segment(input.owner)}/${segment(input.repo)}/pulls/${input.pullNumber}/files`,
            id: `github:${input.installationId}:pull-request-files:${input.owner}/${input.repo}:${input.pullNumber}:page:${currentPage}`,
            kind: "github.pull-request-files",
            sourceId: `${input.owner}/${input.repo}#${input.pullNumber}:files:page:${currentPage}`,
            uri: `https://github.com/${input.owner}/${input.repo}/pull/${input.pullNumber}/files`,
            page: currentPage,
            limit,
            resource: { pullNumber: input.pullNumber },
          }),
        ),
      );
    },
    pullRequestReviews: (input) => {
      const currentPage = input.page ?? 1;
      const limit = input.limit ?? 30;
      return validatePositive(input.pullNumber, "pullNumber").pipe(
        Effect.zipRight(
          readPage({
            ...input,
            path: `/repos/${segment(input.owner)}/${segment(input.repo)}/pulls/${input.pullNumber}/reviews`,
            id: `github:${input.installationId}:pull-request-reviews:${input.owner}/${input.repo}:${input.pullNumber}:page:${currentPage}`,
            kind: "github.pull-request-reviews",
            sourceId: `${input.owner}/${input.repo}#${input.pullNumber}:reviews:page:${currentPage}`,
            uri: `https://github.com/${input.owner}/${input.repo}/pull/${input.pullNumber}`,
            page: currentPage,
            limit,
            resource: { pullNumber: input.pullNumber },
          }),
        ),
      );
    },
    workflowRun: (input) =>
      validatePositive(input.runId, "runId").pipe(
        Effect.zipRight(
          single({
            ...input,
            path: `/repos/${segment(input.owner)}/${segment(input.repo)}/actions/runs/${input.runId}`,
            id: `github:${input.installationId}:workflow-run:${input.owner}/${input.repo}:${input.runId}`,
            kind: "github.workflow-run",
            valueKey: "workflowRun",
            sourceId: `${input.owner}/${input.repo}:workflow-run:${input.runId}`,
            uri: `https://github.com/${input.owner}/${input.repo}/actions/runs/${input.runId}`,
          }),
        ),
      ),
  };
};

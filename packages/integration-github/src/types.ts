import type { ContextItem } from "@openmatter/core";
import type { CredentialResolver } from "@openmatter/credentials";
import type { WorkIntegration } from "@openmatter/integration";
import type { IntegrationError } from "@openmatter/integration";
import type { Effect } from "effect";

export interface GitHubCredentials {
  /** A GitHub App installation access token (or test token). */
  readonly token: string;
}

export type GitHubCredentialResolver = CredentialResolver<GitHubCredentials>;

export type GitHubCredentialSource = (
  installationId: string,
) =>
  | GitHubCredentials
  | PromiseLike<GitHubCredentials>
  | Effect.Effect<GitHubCredentials, IntegrationError>;

export interface GitHubIntegrationCommonOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => string;
  readonly apiBaseUrl?: string;
  readonly apiVersion?: string;
}

export type GitHubIntegrationOptions = GitHubIntegrationCommonOptions &
  (
    | ({ readonly token: string } & { readonly credentials?: never })
    | {
        readonly credentials: GitHubCredentialResolver | GitHubCredentialSource;
        readonly token?: never;
      }
  );

export interface GitHubIntegration {
  readonly integration: WorkIntegration;
  readonly context: GitHubContextReader;
}

export interface GitHubIssueCommentsContextInput {
  readonly installationId: string;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly limit?: number;
  readonly page?: number;
}

export interface GitHubRepositoryContextInput {
  readonly installationId: string;
  readonly owner: string;
  readonly repo: string;
}

export interface GitHubIssueContextInput extends GitHubRepositoryContextInput {
  readonly issueNumber: number;
}

export interface GitHubPullRequestContextInput extends GitHubRepositoryContextInput {
  readonly pullNumber: number;
}

export interface GitHubPullRequestPageContextInput extends GitHubPullRequestContextInput {
  readonly limit?: number;
  readonly page?: number;
}

export interface GitHubWorkflowRunContextInput extends GitHubRepositoryContextInput {
  readonly runId: number;
}

export interface GitHubContextReader {
  readonly repository: (
    input: GitHubRepositoryContextInput,
  ) => Effect.Effect<ContextItem, IntegrationError>;
  readonly issue: (
    input: GitHubIssueContextInput,
  ) => Effect.Effect<ContextItem, IntegrationError>;
  readonly issueComments: (
    input: GitHubIssueCommentsContextInput,
  ) => Effect.Effect<ContextItem, IntegrationError>;
  readonly pullRequest: (
    input: GitHubPullRequestContextInput,
  ) => Effect.Effect<ContextItem, IntegrationError>;
  readonly pullRequestFiles: (
    input: GitHubPullRequestPageContextInput,
  ) => Effect.Effect<ContextItem, IntegrationError>;
  readonly pullRequestReviews: (
    input: GitHubPullRequestPageContextInput,
  ) => Effect.Effect<ContextItem, IntegrationError>;
  readonly workflowRun: (
    input: GitHubWorkflowRunContextInput,
  ) => Effect.Effect<ContextItem, IntegrationError>;
}

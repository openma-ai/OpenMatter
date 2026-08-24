import type { ContextItem } from "@openmatter/core";
import type { CredentialResolver } from "@openmatter/credentials";
import type {
  IntegrationError,
  WorkIntegration,
} from "@openmatter/integration";
import type { Effect } from "effect";

export interface LinearOAuthCredentials {
  readonly kind: "oauth";
  readonly accessToken: string;
}

export interface LinearApiKeyCredentials {
  readonly kind: "apiKey";
  readonly apiKey: string;
}

export type LinearCredentials =
  LinearOAuthCredentials | LinearApiKeyCredentials;

export type LinearCredentialResolver = CredentialResolver<LinearCredentials>;

export type LinearCredentialSource = (
  organizationId: string,
) =>
  | LinearCredentials
  | PromiseLike<LinearCredentials>
  | Effect.Effect<LinearCredentials, IntegrationError>;

export interface LinearIntegrationOptions {
  readonly credentials:
    LinearCredentials | LinearCredentialResolver | LinearCredentialSource;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => string;
  readonly graphqlEndpoint?: string;
}

export interface LinearResourceContextInput {
  readonly organizationId: string;
}

export interface LinearIssueContextInput extends LinearResourceContextInput {
  readonly issueId: string;
}

export interface LinearIssueCommentsContextInput extends LinearIssueContextInput {
  readonly first?: number;
  readonly after?: string;
}

export interface LinearProjectContextInput extends LinearResourceContextInput {
  readonly projectId: string;
}

export interface LinearDocumentContextInput extends LinearResourceContextInput {
  readonly documentId: string;
}

export interface LinearContextReader {
  readonly issue: (
    input: LinearIssueContextInput,
  ) => Effect.Effect<ContextItem, IntegrationError>;
  readonly issueComments: (
    input: LinearIssueCommentsContextInput,
  ) => Effect.Effect<ContextItem, IntegrationError>;
  readonly project: (
    input: LinearProjectContextInput,
  ) => Effect.Effect<ContextItem, IntegrationError>;
  readonly document: (
    input: LinearDocumentContextInput,
  ) => Effect.Effect<ContextItem, IntegrationError>;
}

export interface LinearIntegration {
  readonly integration: WorkIntegration;
  readonly context: LinearContextReader;
}

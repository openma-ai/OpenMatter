import type { ContextItem } from "@openmatter/core";
import type { WorkIntegration } from "@openmatter/integration";
import type { IntegrationError } from "@openmatter/integration";
import type { Effect } from "effect";

export interface SlackIntegrationCommonOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => string;
}

export interface SlackCredentials {
  readonly botToken: string;
  readonly botUserId: string;
}

export type SlackCredentialResolver = (
  teamId: string,
) =>
  | SlackCredentials
  | Promise<SlackCredentials>
  | Effect.Effect<SlackCredentials, IntegrationError>;

export type SlackIntegrationOptions = SlackIntegrationCommonOptions &
  (
    | (SlackCredentials & { readonly credentials?: never })
    | {
        readonly credentials: SlackCredentialResolver;
        readonly botToken?: never;
        readonly botUserId?: never;
      }
  );

export interface SlackIntegration {
  readonly integration: WorkIntegration;
  readonly context: SlackContextReader;
}

export interface SlackThreadContextInput {
  readonly teamId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SlackHistoryContextInput {
  readonly teamId: string;
  readonly channelId: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly oldest?: string;
  readonly latest?: string;
}

export interface SlackContextReader {
  readonly thread: (
    input: SlackThreadContextInput,
  ) => Effect.Effect<ContextItem, IntegrationError>;
  readonly history: (
    input: SlackHistoryContextInput,
  ) => Effect.Effect<ContextItem, IntegrationError>;
  readonly conversation: (input: {
    readonly teamId: string;
    readonly channelId: string;
  }) => Effect.Effect<ContextItem, IntegrationError>;
  readonly user: (input: {
    readonly teamId: string;
    readonly userId: string;
  }) => Effect.Effect<ContextItem, IntegrationError>;
  readonly file: (input: {
    readonly teamId: string;
    readonly fileId: string;
  }) => Effect.Effect<ContextItem, IntegrationError>;
}

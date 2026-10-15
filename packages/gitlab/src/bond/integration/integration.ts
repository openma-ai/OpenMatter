import type { WorkIntegration } from "@openma/matter/integration";
import {
  makeGitLabClient,
  makeGitLabCredentialsFor,
  type GitLabCredentialOption,
} from "./client.js";
import { GITLAB_OPERATIONS, makeGitLabDelivery } from "./delivery.js";
import { GITLAB_EVENT_TYPES, normalizeGitLabEvents } from "./events.js";

export interface GitLabIntegrationOptions {
  /**
   * Credentials for replies: fixed `{ baseUrl, token }`, or a resolver keyed
   * by the Event authority (for example a Bond's app principal).
   */
  readonly credentials: GitLabCredentialOption;
  readonly fetch?: typeof globalThis.fetch;
  readonly clock?: () => string;
}

/**
 * The GitLab work integration: `ingest` takes a `GitLabWebhookInput` from
 * `decodeGitLabHttpRequest`, and `deliver` posts merge request and issue
 * notes.
 */
export const makeGitLabIntegration = (
  options: GitLabIntegrationOptions,
): WorkIntegration => {
  const clock = options.clock ?? (() => new Date().toISOString());
  const client = makeGitLabClient({
    credentialsFor: makeGitLabCredentialsFor(options.credentials),
    fetch: options.fetch ?? ((...args) => globalThis.fetch(...args)),
    clock,
  });
  return {
    manifest: {
      id: "gitlab",
      displayName: "GitLab",
      events: GITLAB_EVENT_TYPES,
      operations: GITLAB_OPERATIONS,
    },
    ingest: (input) => normalizeGitLabEvents(input, clock),
    deliver: makeGitLabDelivery(client),
  };
};

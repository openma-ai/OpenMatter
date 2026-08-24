import type { WorkIntegration } from "@openmatter/integration";
import { makeGitHubContextReader } from "./context.js";
import { makeGitHubCredentialsFor } from "./credentials.js";
import { makeGitHubEffectDelivery } from "./effect-delivery.js";
import { normalizeGitHubEvents } from "./event-normalization.js";
import { makeGitHubProviderClient } from "./provider-client.js";
import type { GitHubIntegration, GitHubIntegrationOptions } from "./types.js";

export const makeGitHubIntegration = (
  options: GitHubIntegrationOptions,
): GitHubIntegration => {
  const clock = options.clock ?? (() => new Date().toISOString());
  const credentialsFor = makeGitHubCredentialsFor(options);
  const provider = makeGitHubProviderClient({
    credentialsFor,
    fetchImplementation: options.fetch ?? globalThis.fetch,
    apiBaseUrl: options.apiBaseUrl ?? "https://api.github.com/",
    apiVersion: options.apiVersion ?? "2026-03-10",
    clock,
  });
  const deliver: WorkIntegration["deliver"] =
    makeGitHubEffectDelivery(provider);

  return {
    context: makeGitHubContextReader(provider),
    integration: {
      manifest: {
        id: "github",
        displayName: "GitHub",
        events: [
          "github.issue.opened",
          "github.issue.edited",
          "github.issue.closed",
          "github.issue.reopened",
          "github.issue.labeled",
          "github.issue.unlabeled",
          "github.issue.assigned",
          "github.issue.unassigned",
          "github.issue.comment.created",
          "github.issue.comment.edited",
          "github.issue.comment.deleted",
          "github.pull_request.opened",
          "github.pull_request.edited",
          "github.pull_request.synchronize",
          "github.pull_request.ready_for_review",
          "github.pull_request.review_requested",
          "github.pull_request.closed",
          "github.pull_request.reopened",
          "github.pull_request.comment.created",
          "github.pull_request.comment.edited",
          "github.pull_request.comment.deleted",
          "github.pull_request.review.submitted",
          "github.pull_request.review.edited",
          "github.pull_request.review.dismissed",
          "github.pull_request.review_comment.created",
          "github.pull_request.review_comment.edited",
          "github.pull_request.review_comment.deleted",
          "github.workflow_run.requested",
          "github.workflow_run.in_progress",
          "github.workflow_run.completed",
          "github.installation.created",
          "github.installation.deleted",
          "github.installation.suspend",
          "github.installation.unsuspend",
          "github.installation.repositories.added",
          "github.installation.repositories.removed",
          "github.event.received",
        ],
        operations: [
          "issue.comment.create",
          "issue.comment.update",
          "issue.comment.delete",
          "issue.update",
          "issue.reaction.add",
          "issue.reaction.delete",
          "issue.comment.reaction.add",
          "issue.comment.reaction.delete",
          "pull_request.review.create",
          "pull_request.review_comment.create",
          "pull_request.merge",
          "workflow.dispatch",
        ],
      },
      ingest: (input) => normalizeGitHubEvents(input, clock),
      deliver,
    },
  };
};

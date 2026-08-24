import { IntegrationError } from "@openmatter/integration";
import { Effect } from "effect";
import { makeLinearContextReader } from "./context.js";
import { makeLinearCredentialsFor } from "./credentials.js";
import { makeLinearEffectDelivery } from "./effect-delivery.js";
import { normalizeLinearEvents } from "./event-normalization.js";
import { makeLinearProviderClient } from "./provider-client.js";
import type { LinearIntegration, LinearIntegrationOptions } from "./types.js";

export {
  decodeLinearHttpRequest,
  LinearHttpIngressError,
  LinearHttpSubmissionError,
  LinearRequestVerificationError,
  makeLinearHttpEndpoint,
  verifyLinearRequest,
} from "./http.js";
export type {
  LinearHttpEndpointOptions,
  LinearHttpRequestOptions,
  LinearRequestVerificationInput,
  LinearWebhookInput,
} from "./http.js";

export const makeLinearIntegration = (
  options: LinearIntegrationOptions,
): LinearIntegration => {
  const clock = options.clock ?? (() => new Date().toISOString());
  const credentialsFor = makeLinearCredentialsFor(options);
  const provider = makeLinearProviderClient({
    credentialsFor,
    fetchImplementation: options.fetch ?? globalThis.fetch,
    endpoint: options.graphqlEndpoint ?? "https://api.linear.app/graphql",
  });
  const deliver = makeLinearEffectDelivery(provider);
  return {
    context: makeLinearContextReader(provider),
    integration: {
      manifest: {
        id: "linear",
        displayName: "Linear",
        events: [
          "linear.issue.created",
          "linear.issue.updated",
          "linear.issue.removed",
          "linear.comment.created",
          "linear.comment.updated",
          "linear.comment.removed",
          "linear.project.created",
          "linear.project.updated",
          "linear.project.removed",
          "linear.document.created",
          "linear.document.updated",
          "linear.document.removed",
          "linear.issue.assigned-to-agent",
          "linear.issue.mentioned",
          "linear.comment.mentioned",
          "linear.issue.comment-received",
          "linear.agent-session.created",
          "linear.agent-session.prompted",
          "linear.event.received",
        ],
        operations: [
          "issue.create",
          "issue.update",
          "issue.comment.create",
          "issue.comment.update",
          "issue.comment.delete",
          "project.update",
          "document.update",
        ],
      },
      ingest: (input) => {
        if (
          typeof input !== "object" ||
          input === null ||
          !("kind" in input) ||
          input.kind !== "linear.webhook"
        ) {
          return Effect.fail(
            new IntegrationError({
              message:
                "Linear ingest requires a verified linear.webhook delivery envelope",
              retryable: false,
            }),
          );
        }
        return Effect.succeed(normalizeLinearEvents(input, clock));
      },
      deliver,
    },
  };
};

export type {
  LinearApiKeyCredentials,
  LinearContextReader,
  LinearCredentialResolver,
  LinearCredentials,
  LinearCredentialSource,
  LinearDocumentContextInput,
  LinearIntegration,
  LinearIntegrationOptions,
  LinearIssueCommentsContextInput,
  LinearIssueContextInput,
  LinearOAuthCredentials,
  LinearProjectContextInput,
} from "./types.js";

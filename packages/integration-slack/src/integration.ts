import type { WorkIntegration } from "@openmatter/integration";
import { Effect } from "effect";
import { makeSlackContextReader } from "./context.js";
import { makeSlackCredentialsFor } from "./credentials.js";
import { makeSlackEffectDelivery } from "./effect-delivery.js";
import { normalizeSlackEvents } from "./event-normalization.js";
import { makeSlackProviderClient } from "./provider-client.js";
import { slackAuthorityFrom } from "./shared.js";
import type { SlackIntegration, SlackIntegrationOptions } from "./types.js";

export const makeSlackIntegration = (
  options: SlackIntegrationOptions,
): SlackIntegration => {
  const clock = options.clock ?? (() => new Date().toISOString());
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const credentialsFor = makeSlackCredentialsFor(options);
  const provider = makeSlackProviderClient({
    clock,
    credentialsFor,
    fetchImplementation,
  });

  const ingest: WorkIntegration["ingest"] = (input) => {
    const authority = slackAuthorityFrom(input);
    return credentialsFor(authority).pipe(
      Effect.flatMap(({ botUserId }) =>
        normalizeSlackEvents(input, botUserId, authority, clock),
      ),
    );
  };
  const context = makeSlackContextReader(provider);
  const deliver = makeSlackEffectDelivery({
    apiCall: provider.apiCall,
    fetchImplementation,
    retryAtFrom: provider.retryAtFrom,
  });

  return {
    context,
    integration: {
      manifest: {
        id: "slack",
        displayName: "Slack",
        events: [
          "slack.message.mentioned",
          "slack.message.received",
          "slack.message.updated",
          "slack.message.deleted",
          "slack.reaction.added",
          "slack.reaction.removed",
          "slack.command.invoked",
          "slack.action.invoked",
          "slack.shortcut.invoked",
          "slack.form.submitted",
          "slack.form.closed",
          "slack.event.received",
        ],
        operations: [
          "message.reply",
          "message.post",
          "message.ephemeral",
          "message.react",
          "message.unreact",
          "message.update",
          "message.delete",
          "message.schedule",
          "message.schedule.cancel",
          "view.open",
          "view.update",
          "view.push",
          "home.publish",
          "file.upload",
        ],
      },
      ingest,
      deliver,
    },
  };
};

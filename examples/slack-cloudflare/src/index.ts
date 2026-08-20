import type { AgentDriver } from "@openmatter/agent";
import {
  makeCloudflareRuntime,
  type CloudflareQueueBatch,
  type CloudflareQueuePort,
} from "@openmatter/host-cloudflare";
import { makeSlackIntegration } from "@openmatter/integration-slack";
import { installClaudeTag } from "@openmatter/orchestration";
import { createOpenMatter } from "@openmatter/runtime";
import type { OpenMatterStore } from "@openmatter/store";

export interface Environment {
  readonly SLACK_BOT_TOKEN: string;
  readonly SLACK_BOT_USER_ID: string;
  readonly SLACK_SIGNING_SECRET: string;
  readonly EVENTS: CloudflareQueuePort;
}

export interface CloudflarePorts {
  /** A durable Store adapter backed by D1, Postgres, Redis, or another service. */
  readonly store: (environment: Environment) => OpenMatterStore;
  /** ACP, a managed-agent adapter, or any custom AgentDriver. */
  readonly claude: (environment: Environment) => AgentDriver;
}

export const makeWorker = (ports: CloudflarePorts) => {
  const runtime = makeCloudflareRuntime<Environment>({
    application: (environment) => {
      const slack = makeSlackIntegration({
        botToken: environment.SLACK_BOT_TOKEN,
        botUserId: environment.SLACK_BOT_USER_ID,
      });
      const app = createOpenMatter({
        store: ports.store(environment),
        integrations: { slack: slack.integration },
        agents: { claude: ports.claude(environment) },
      });
      installClaudeTag(app, {
        agentId: "claude",
        context: (work) => [
          work.context.value({
            kind: "channel-policy",
            value: { source: "application", activation: "mention-only" },
            provenance: [
              {
                sourceType: "application-config",
                sourceId: "cloudflare-worker",
              },
            ],
          }),
        ],
      });
      return app;
    },
    slack: {
      signingSecret: (environment) => environment.SLACK_SIGNING_SECRET,
      queue: (environment) => environment.EVENTS,
    },
  });

  return {
    fetch: (request: Request, environment: Environment) =>
      runtime.fetch(request, environment),
    queue: (batch: CloudflareQueueBatch, environment: Environment) =>
      runtime.queue(batch, environment),
  };
};

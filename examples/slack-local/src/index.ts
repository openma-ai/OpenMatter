import type { AgentDriver } from "@openma/matter-agent";
import { makeLocalSlackRuntime } from "@openma/matter-host-local";
import type { DurableInbox } from "@openma/matter-inbox";
import { makeSlackIntegration } from "@openma/matter-integration-slack";
import { claudeTag } from "@openma/matter-orchestration";
import { createOpenMatter } from "@openma/matter-runtime";
import type { OpenMatterStore } from "@openma/matter-store";

export interface LocalSlackOptions {
  readonly appToken: string;
  readonly botToken: string;
  readonly botUserId: string;
  readonly store: OpenMatterStore;
  readonly inbox: DurableInbox;
  readonly claude: AgentDriver;
  readonly recoveryIntervalMs?: number | false;
  readonly onError?: (error: unknown) => void;
}

export const makeLocalSlackService = (options: LocalSlackOptions) => {
  const slack = makeSlackIntegration({
    botToken: options.botToken,
    botUserId: options.botUserId,
  });
  const app = createOpenMatter({
    store: options.store,
    integrations: { slack: slack.integration },
    agents: { claude: options.claude },
  });
  app.loop(claudeTag({ agentId: "claude" }));

  return makeLocalSlackRuntime({
    appToken: options.appToken,
    application: app,
    inbox: options.inbox,
    ...(options.recoveryIntervalMs === undefined
      ? {}
      : { recoveryIntervalMs: options.recoveryIntervalMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
};

// No public Request URL is needed. Compose a persistent inbox, for example
// makeSqliteInbox({ filename: "./data/openmatter-inbox.sqlite" }), and pass it
// as `inbox` alongside a durable OpenMatterStore:
// const service = makeLocalSlackService({ ..., inbox });
// await service.start();
// await service.stop();

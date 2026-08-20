import type { AgentDriver } from "@openmatter/agent";
import { makeLocalSlackRuntime } from "@openmatter/host-local";
import { makeSlackIntegration } from "@openmatter/integration-slack";
import { installClaudeTag } from "@openmatter/orchestration";
import { createOpenMatter } from "@openmatter/runtime";
import type { OpenMatterStore } from "@openmatter/store";

export interface LocalSlackOptions {
  readonly appToken: string;
  readonly botToken: string;
  readonly botUserId: string;
  readonly store: OpenMatterStore;
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
  installClaudeTag(app, { agentId: "claude" });

  return makeLocalSlackRuntime({
    appToken: options.appToken,
    application: app,
    ...(options.recoveryIntervalMs === undefined
      ? {}
      : { recoveryIntervalMs: options.recoveryIntervalMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
};

// No public Request URL is needed:
// const service = makeLocalSlackService({ ... });
// await service.start();
// await service.stop();

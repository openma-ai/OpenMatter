import { AgentContent, JsonObject, OpenMAAgentConnector } from "@openma/common/agent-contract";
import { AgentDriver } from "@openmatter/agent";
import { ContextProjection } from "@openmatter/core";
//#region src/index.d.ts
interface ClaudeAgentDriverOptions {
  readonly connector: OpenMAAgentConnector;
  readonly agentId: string;
  readonly id?: string;
  readonly content?: (context: ContextProjection) => AgentContent;
  readonly session?: {
    readonly cwd?: string;
    readonly additionalDirectories?: readonly string[];
    readonly metadata?: JsonObject;
  };
  /** Distinguish a missing/expired remote Session from transient transport errors. */
  readonly isSessionUnavailable?: (cause: unknown) => boolean;
}
declare const makeClaudeAgentDriver: (options: ClaudeAgentDriverOptions) => AgentDriver;
//#endregion
export { ClaudeAgentDriverOptions, makeClaudeAgentDriver };
//# sourceMappingURL=index.d.ts.map
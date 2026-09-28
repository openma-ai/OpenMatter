import { AgentDriver } from "@openmatter/agent";
//#region src/index.d.ts
interface MockAgentDriver {
  readonly driver: AgentDriver;
  readonly permissionResponses: () => readonly {
    readonly requestId: string;
    readonly approved: boolean;
  }[];
  readonly cancelledTurns: () => readonly string[];
  readonly createdSessions: () => number;
}
declare const makeMockAgentDriver: (options: {
  readonly id: string;
  readonly output: string;
  readonly omitTerminal?: boolean;
  readonly neverComplete?: boolean;
  readonly terminalType?: "turn.completed" | "turn.failed" | "turn.cancelled" | "turn.interrupted";
  readonly permissionRequestId?: string;
  readonly resume?: boolean;
}) => MockAgentDriver;
//#endregion
export { MockAgentDriver, makeMockAgentDriver };
//# sourceMappingURL=index.d.ts.map
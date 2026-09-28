import { McpServer } from "@modelcontextprotocol/server";
import { ThreadGoal } from "@openmatter/core";
import { ProjectControl } from "@openmatter/project";
import { ProjectStatus, ProjectStatusQuery } from "@openmatter/project-host";
//#region src/index.d.ts
interface ProjectMcpServerOptions {
  readonly control?: ProjectControl;
  /** Defaults to the minimal Router surface: `delegate` only. */
  readonly tools?: readonly ProjectControlTool[];
  readonly name?: string;
  readonly version?: string;
  /** Reads only the project already bound by the host; no caller-selected scope. */
  readonly readStatus?: (query: ProjectStatusQuery) => Promise<ProjectStatus>;
  /** Bound by the authenticated host, never selected in model arguments. */
  readonly goal?: {
    readonly get: () => Promise<ThreadGoal | null>;
    readonly create: (input: {
      objective: string;
      tokenBudget?: number;
    }) => Promise<ThreadGoal>;
    readonly update: (input: {
      status: "complete" | "blocked";
      reason?: string;
    }) => Promise<ThreadGoal>;
  };
}
declare const THREAD_GOAL_INSTRUCTIONS = "Goal tracking belongs to this WorkThread and is managed by OpenMatter. Use only get_goal, create_goal and update_goal from the OpenMatter Project MCP server for it; do not start a provider-native goal or another automatic continuation loop. Create a goal only when explicitly requested; an ordinary task or delegation alone does not request goal tracking. Supply a token budget only when explicitly requested. Inspect the current goal before creating one. Ending a turn does not complete a goal. Mark complete only after verifying the entire objective against current evidence. Mark blocked only when the same genuine obstacle prevents meaningful progress for at least three consecutive goal turns; after an explicit resume, begin a fresh blocked audit. Do not mark blocked merely because work is slow, difficult or incomplete. Pause, resume and budget changes belong to the user or host; do not change them through other tools. Report the returned status and final usage when completing a budgeted goal.";
type ProjectControlTool = "delegate" | "steer" | "cancel" | "complete";
/** Build a transport-neutral MCP server bound to exactly one Project Scope. */
declare const makeProjectMcpServer: (options: ProjectMcpServerOptions) => McpServer;
//#endregion
export { ProjectControlTool, ProjectMcpServerOptions, THREAD_GOAL_INSTRUCTIONS, makeProjectMcpServer };
//# sourceMappingURL=index.d.ts.map
import { DatabaseSync } from "node:sqlite";
import "@openmatter/store-sqlite";
import "@openmatter/runtime";
import { AgentSession, JsonValue, ThreadGoal, ThreadGoal as ThreadGoal$1, Turn } from "@openmatter/core";
import { StoreSnapshot } from "@openmatter/store";
import { AgentDriver } from "@openmatter/agent";
//#region src/goals.d.ts
interface ProjectGoalInput {
  projectId: string;
  workThreadId: string;
  objective?: string;
  status?: 'active' | 'paused';
  tokenBudget?: number | null;
  clear?: boolean;
}
declare function projectWorkThreadId(projectId: string, runId?: string, workerId?: string): string;
//#endregion
//#region src/workspaces.d.ts
interface ProjectWorkspaceBinding {
  id: string;
  projectId: string;
  workThreadId: string;
  branch: string;
  spec: JsonValue;
  location: JsonValue | null;
}
/** Thread-owned identity. Session generations and agent selection do not own a checkout. */
declare class ProjectWorkspaceRegistry {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync);
  reserve(projectId: string, workThreadId: string, spec: JsonValue): ProjectWorkspaceBinding;
  get(id: string): ProjectWorkspaceBinding | undefined;
  complete(id: string, location: JsonValue): void;
  list(projectId: string): ProjectWorkspaceBinding[];
}
//#endregion
//#region src/types.d.ts
interface ProjectWorkConfig {
  projectId: string;
  /** New threads start here; existing workspaces retain their original base. */
  baseRef?: string;
  /** Cloud repository resources; credentials stay on the worker. */
  repositories?: {
    url: string;
    baseRef?: string;
  }[];
  description: string;
  instructions: string;
  context: string;
  resources: {
    id: string;
    name: string;
    text: string;
  }[];
  coordinatorAgent: string;
  coordinatorEnvironment?: string;
  workerEnvironment?: string;
  workerAgent: string;
  continuity: "per-scope" | "per-run";
  controls: ("delegate" | "steer" | "cancel" | "complete")[];
}
interface ProjectWorkView<TProject extends {
  id: string;
  name: string;
} = {
  id: string;
  name: string;
}> {
  project: TProject;
  config: ProjectWorkConfig | null;
  facts: StoreSnapshot;
  workspaces?: ProjectWorkspaceBinding[];
  pending: number;
  error: string | null;
}
interface ProjectWorkCommand {
  projectId: string;
  commandId: string;
  runId?: string;
  type: "message" | "delegate" | "steer" | "cancel" | "complete";
  text: string;
  attachments?: ProjectAttachment[];
  workerId?: string;
}
type ProjectAttachment = {
  id: string;
  name: string;
  kind: "image" | "file";
  mimeType: string;
  data: string;
};
//#endregion
//#region src/attachments.d.ts
declare const PROJECT_ATTACHMENT_LIMIT: number;
declare function validateProjectAttachments(input: unknown): asserts input is ProjectAttachment[] | undefined;
declare function projectPromptAttachments(items: readonly {
  kind: string;
  value: unknown;
}[]): ProjectAttachment[];
/** Binary payloads travel as native content blocks, never a base64 wall in text. */
declare function projectContextText(items: unknown): string;
//#endregion
//#region src/status.d.ts
interface ProjectStatusQuery {
  readonly workerId?: string;
  readonly limit?: number;
}
interface ProjectStatusThread {
  readonly workThreadId: string;
  readonly role: "coordinator" | "worker";
  readonly workerId?: string;
  readonly runId?: string;
  readonly session: Pick<AgentSession, "id" | "agentId" | "state" | "generation" | "lastUsedAt">;
  readonly turn?: Pick<Turn, "id" | "state" | "createdAt" | "completedAt"> & {
    readonly summary?: string;
    readonly summaryTruncated?: boolean;
    readonly error?: string;
  };
  /** Durable WorkThread outcome; a completed turn is not this status. */
  readonly outcome?: Pick<ThreadGoal$1, "id" | "objective" | "status" | "tokensUsed" | "timeUsedSeconds" | "tokenBudget" | "reason" | "revision">;
  readonly remote?: string;
  readonly links?: ProjectExternalLink[];
}
interface ProjectExternalLink {
  readonly provider: string;
  readonly kind: "pull_request" | "merge_request" | "check" | "review" | "commit" | "other";
  readonly externalId?: string;
  readonly title?: string;
  readonly url?: string;
  readonly state?: string;
}
/** Execution facts only. A completed turn does not imply task review or acceptance. */
interface ProjectStatus {
  readonly project: {
    readonly id: string;
    readonly name: string;
  };
  readonly pending: number;
  readonly error: string | null;
  readonly threads: readonly ProjectStatusThread[];
  readonly totalThreads: number;
  readonly truncated: boolean;
}
/** Bounded, read-only projection of facts for the host-selected project. */
declare function projectStatus(view: ProjectWorkView, query?: ProjectStatusQuery): ProjectStatus;
//#endregion
//#region src/index.d.ts
interface ProjectWorkDeps<TProject extends {
  id: string;
  name: string;
}> {
  directory: string;
  getProject(id: string): TProject | null;
  driver(id: string, project: TProject, role: "coordinator" | "worker", config: ProjectWorkConfig): AgentDriver;
}
/** Host configuration and durable inbox delivery. All work executes inside OpenMatter. */
declare class ProjectWorkService<TProject extends {
  id: string;
  name: string;
}> {
  #private;
  readonly db: DatabaseSync;
  readonly workspaces: ProjectWorkspaceRegistry;
  readonly store: import("@openmatter/store-sqlite").SqliteStore;
  readonly inbox: import("@openmatter/inbox-sqlite").SqliteInbox;
  constructor(deps: ProjectWorkDeps<TProject>);
  config(id: string): ProjectWorkConfig | null;
  save(config: ProjectWorkConfig): Promise<ProjectWorkConfig>;
  view(id: string): Promise<ProjectWorkView<TProject>>;
  /** The tool binding supplies business scope; models cannot choose another project. */
  control(projectId: string, runId?: string, commandId?: string): import("@openmatter/project").ProjectControl;
  submit(input: ProjectWorkCommand): Promise<void>;
  setGoal(input: ProjectGoalInput): Promise<ThreadGoal$1 | null>;
  goalControl(projectId: string, workThreadId: string): {
    get: () => Promise<ThreadGoal$1 | null>;
    create: (input: {
      objective: string;
      tokenBudget?: number;
    }) => Promise<ThreadGoal$1>;
    update: (input: {
      status: "complete" | "blocked";
      reason?: string;
    }) => Promise<ThreadGoal$1>;
  };
  drain(): Promise<void>;
  start(): void;
  stop(): void;
  close(): Promise<void>;
}
//#endregion
export { PROJECT_ATTACHMENT_LIMIT, type ProjectAttachment, type ProjectGoalInput, type ProjectStatus, type ProjectStatusQuery, type ProjectStatusThread, type ProjectWorkCommand, type ProjectWorkConfig, ProjectWorkDeps, ProjectWorkService, type ProjectWorkView, type ProjectWorkspaceBinding, ProjectWorkspaceRegistry, type ThreadGoal, projectContextText, projectPromptAttachments, projectStatus, projectWorkThreadId, validateProjectAttachments };
//# sourceMappingURL=index.d.ts.map
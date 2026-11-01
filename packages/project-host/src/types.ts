import type { JsonValue } from "@openma/matter";
import type { StoreSnapshot } from "@openma/matter/store";
export interface ProjectWorkConfig {
  projectId: string;
  /** New threads start here; existing workspaces retain their original base. */
  baseRef?: string;
  /** Cloud repository resources; credentials stay on the worker. */
  repositories?: { url: string; baseRef?: string }[];
  description: string;
  instructions: string;
  context: string;
  resources: { id: string; name: string; text: string }[];
  coordinatorAgent: string;
  coordinatorEnvironment?: string;
  workerEnvironment?: string;
  workerAgent: string;
  continuity: "per-scope" | "per-run";
  /**
   * `thread` (default): each WorkThread owns a workspace binding (branch
   * `openmatter/<id>`) and the list is injected as `project-workspaces` context.
   * `none`: non-git work; no workspace registration, branch naming, or context.
   */
  workspace?: "thread" | "none";
  /**
   * Enable coordinator-thread live steering for this project. When true, a
   * message arriving while the coordinator Turn is running joins that Turn
   * instead of waiting for another one. Requires a coordinator driver that
   * declares `steering` and implements `steer`.
   */
  steerCoordinator?: boolean;
  controls: ("delegate" | "steer" | "cancel" | "complete")[];
}
export interface ProjectWorkView<
  TProject extends { id: string; name: string } = { id: string; name: string },
> {
  project: TProject;
  config: ProjectWorkConfig | null;
  facts: StoreSnapshot;
  workspaces?: import("./workspaces.js").ProjectWorkspaceBinding[];
  pending: number;
  error: string | null;
}
export interface ProjectWorkCommand {
  projectId: string;
  commandId: string;
  runId?: string;
  type: "message" | "delegate" | "steer" | "cancel" | "complete";
  text: string;
  attachments?: ProjectAttachment[];
  workerId?: string;
  /** Host-supplied message identity carried on the `project.message` payload,
   * for a project fed by an external conversation. Never model-chosen. */
  origin?: JsonValue;
}

export type ProjectAttachment = {
  id: string;
  name: string;
  kind: "image" | "file";
  mimeType: string;
  data: string;
};

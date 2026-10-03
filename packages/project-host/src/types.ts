import type { StoreSnapshot } from "@openmatter/store";
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
}

export type ProjectAttachment = {
  id: string;
  name: string;
  kind: "image" | "file";
  mimeType: string;
  data: string;
};

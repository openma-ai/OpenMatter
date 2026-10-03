import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@openmatter/core";
export interface ProjectWorkspaceBinding {
  id: string;
  projectId: string;
  workThreadId: string;
  branch: string;
  spec: JsonValue;
  location: JsonValue | null;
}
/** Thread-owned identity. Session generations and agent selection do not own a checkout. */
export class ProjectWorkspaceRegistry {
  constructor(readonly db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS openmatter_project_workspaces(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,thread_id TEXT NOT NULL,spec TEXT NOT NULL,location TEXT,UNIQUE(project_id,thread_id))",
    );
  }
  reserve(
    projectId: string,
    workThreadId: string,
    spec: JsonValue,
  ): ProjectWorkspaceBinding {
    if (!projectId || !workThreadId)
      throw new Error("Workspace requires a project and WorkThread");
    const id =
      "thread-" +
      createHash("sha256")
        .update(JSON.stringify([projectId, workThreadId]))
        .digest("hex")
        .slice(0, 32);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO openmatter_project_workspaces(id,project_id,thread_id,spec) VALUES(?,?,?,?)",
      )
      .run(id, projectId, workThreadId, JSON.stringify(spec));
    return this.get(id)!;
  }
  get(id: string): ProjectWorkspaceBinding | undefined {
    const row = this.db
      .prepare("SELECT * FROM openmatter_project_workspaces WHERE id=?")
      .get(id);
    return row
      ? {
          id: String(row.id),
          projectId: String(row.project_id),
          workThreadId: String(row.thread_id),
          branch: `openmatter/${row.id}`,
          spec: JSON.parse(String(row.spec)),
          location: row.location ? JSON.parse(String(row.location)) : null,
        }
      : undefined;
  }
  complete(id: string, location: JsonValue) {
    const previous = this.get(id);
    if (!previous) throw new Error("Unknown workspace");
    if (
      previous.location &&
      JSON.stringify(previous.location) !== JSON.stringify(location)
    )
      throw new Error("Workspace location is immutable");
    this.db
      .prepare("UPDATE openmatter_project_workspaces SET location=? WHERE id=?")
      .run(JSON.stringify(location), id);
  }
  list(projectId: string) {
    return this.db
      .prepare(
        "SELECT id FROM openmatter_project_workspaces WHERE project_id=? ORDER BY rowid",
      )
      .all(projectId)
      .map((row) => this.get(String(row.id))!);
  }
}

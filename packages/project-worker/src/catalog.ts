import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  createPool,
  type Pool,
  type PoolConnection,
  type RowDataPacket,
} from "mysql2/promise";
import type { JsonValue } from "@openmatter/core";
import type { ProjectWorkConfig } from "@openmatter/project-host";

export interface StoredProject {
  readonly project: {
    id: string;
    name: string;
    [key: string]: JsonValue | undefined;
  };
  readonly config: ProjectWorkConfig & {
    execution?: {
      kind: string;
      baseUrl?: string;
      workspaceId?: string;
      userId?: string;
    };
  };
}

export interface StoredCommand {
  readonly id: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly kind: "event" | "project";
  readonly body: JsonValue;
  readonly state: "pending" | "waiting" | "completed";
  readonly error: string | null;
}

export interface StoredThread {
  readonly workThreadId: string;
  readonly role: "coordinator" | "worker";
  readonly sessionId: string | null;
  readonly creationKey: string;
  readonly branch: string | null;
  readonly placement: "cloud" | "local" | null;
  readonly runtimeId: string | null;
  readonly runtimeStatus: string | null;
}

export interface ProjectCatalog {
  readonly putProject: (
    tenantId: string,
    project: StoredProject["project"],
    config: StoredProject["config"],
  ) => Promise<void>;
  readonly getProject: (
    tenantId: string,
    projectId: string,
  ) => Promise<StoredProject | null>;
  readonly listProjects: (
    tenantId: string,
    cursor: number,
    limit: number,
  ) => Promise<{ data: StoredProject[]; nextCursor: number | null }>;
  readonly deleteProject: (
    tenantId: string,
    projectId: string,
  ) => Promise<void>;
  readonly putCommand: (
    command: StoredCommand,
  ) => Promise<"inserted" | "duplicate" | "conflict">;
  readonly claimCommands: (
    limit: number,
    now: number,
    leaseMs: number,
  ) => Promise<StoredCommand[]>;
  readonly completeCommand: (
    tenantId: string,
    id: string,
    error?: string,
  ) => Promise<void>;
  readonly waitCommand: (
    tenantId: string,
    id: string,
    error: string,
    until: number,
  ) => Promise<void>;
  readonly pendingCount: (
    tenantId: string,
    projectId: string,
  ) => Promise<number>;
  readonly lastError: (
    tenantId: string,
    projectId: string,
  ) => Promise<string | null>;
  readonly putCredential: (
    tenantId: string,
    ciphertext: string,
  ) => Promise<void>;
  readonly getCredential: (tenantId: string) => Promise<string | null>;
  readonly rememberThread: (
    tenantId: string,
    projectId: string,
    thread: StoredThread,
  ) => Promise<void>;
  readonly getThread: (
    tenantId: string,
    projectId: string,
    workThreadId: string,
  ) => Promise<StoredThread | null>;
  readonly listThreads: (
    tenantId: string,
    projectId: string,
  ) => Promise<StoredThread[]>;
  readonly recordUsage: (input: {
    tenantId: string;
    projectId: string;
    workThreadId: string;
    turnId: string;
    tokens: number;
    seconds: number;
  }) => Promise<void>;
  readonly usageTotal: (tenantId: string, projectId: string) => Promise<number>;
  readonly recordGoalAudit: (
    goalId: string,
    turnId: string,
    empty: boolean,
  ) => Promise<void>;
  readonly recentGoalAudit: (goalId: string) => Promise<boolean[]>;
  readonly resetGoalAudit: (goalId: string) => Promise<void>;
  readonly releaseLeases: () => Promise<void>;
  readonly close: () => Promise<void>;
}

type Row = Record<string, unknown>;

interface Queryable {
  exec(sql: string): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
}

const statements = (dialect: "sqlite" | "mysql") => {
  const text = dialect === "mysql" ? "VARCHAR(191)" : "TEXT";
  const body = dialect === "mysql" ? "LONGTEXT" : "TEXT";
  return [
    `CREATE TABLE IF NOT EXISTS project_worker_projects (
      tenant_id ${text} NOT NULL, project_id ${text} NOT NULL, project_json ${body} NOT NULL, config_json ${body} NOT NULL,
      PRIMARY KEY (tenant_id, project_id))`,
    `CREATE TABLE IF NOT EXISTS project_worker_commands (
      tenant_id ${text} NOT NULL, id ${text} NOT NULL, project_id ${text} NOT NULL, kind ${text} NOT NULL,
      body_json ${body} NOT NULL, state ${text} NOT NULL, error ${body}, lease_expires_ms BIGINT, created_ms BIGINT NOT NULL,
      PRIMARY KEY (tenant_id, id))`,
    `CREATE TABLE IF NOT EXISTS project_worker_credentials (
      tenant_id ${text} PRIMARY KEY, ciphertext ${body} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS project_worker_threads (
      tenant_id ${text} NOT NULL, project_id ${text} NOT NULL, work_thread_id ${text} NOT NULL, role ${text} NOT NULL,
      session_id ${text}, creation_key ${text} NOT NULL, branch ${text}, placement ${text}, runtime_id ${text}, runtime_status ${text},
      PRIMARY KEY (tenant_id, project_id, work_thread_id))`,
    `CREATE TABLE IF NOT EXISTS project_worker_usage (
      tenant_id ${text} NOT NULL, project_id ${text} NOT NULL, work_thread_id ${text} NOT NULL, turn_id ${text} NOT NULL,
      tokens BIGINT NOT NULL, seconds BIGINT NOT NULL, PRIMARY KEY (tenant_id, project_id, work_thread_id, turn_id))`,
    `CREATE TABLE IF NOT EXISTS project_worker_goal_audit (
      goal_id ${text} NOT NULL, turn_id ${text} NOT NULL, empty_turn INT NOT NULL, PRIMARY KEY (goal_id, turn_id))`,
  ];
};

const sqliteQueryable = (
  filename: string,
): Queryable & { close(): Promise<void> } => {
  mkdirSync(filename.slice(0, filename.lastIndexOf("/")), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  for (const statement of statements("sqlite")) db.exec(statement);
  return {
    exec: async (sql) => {
      db.exec(sql);
    },
    all: async (sql, params = []) =>
      db.prepare(sql).all(...(params as never[])) as never,
    run: async (sql, params = []) => {
      db.prepare(sql).run(...(params as never[]));
    },
    close: async () => {
      db.close();
    },
  };
};

const mysqlQueryable = (pool: Pool): Queryable & { close(): Promise<void> } => {
  const q = async (
    conn: Pool | PoolConnection,
    sql: string,
    params: unknown[] = [],
  ) => {
    const [rows] = await conn.query<RowDataPacket[]>(sql, params);
    return rows;
  };
  return {
    exec: async (sql) => {
      await pool.query(sql);
    },
    all: async (sql, params = []) => q(pool, sql, params) as Promise<never>,
    run: async (sql, params = []) => {
      await pool.query(sql, params);
    },
    close: async () => {
      await pool.end();
    },
  };
};

const projectFrom = (row: Row): StoredProject => ({
  project: JSON.parse(String(row.project_json)),
  config: JSON.parse(String(row.config_json)),
});

const commandFrom = (row: Row): StoredCommand => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  projectId: String(row.project_id),
  kind: row.kind === "project" ? "project" : "event",
  body: JSON.parse(String(row.body_json)),
  state:
    row.state === "waiting" || row.state === "completed"
      ? row.state
      : "pending",
  error: row.error == null ? null : String(row.error),
});

const threadFrom = (row: Row): StoredThread => ({
  workThreadId: String(row.work_thread_id),
  role: row.role === "worker" ? "worker" : "coordinator",
  sessionId: row.session_id == null ? null : String(row.session_id),
  creationKey: String(row.creation_key),
  branch: row.branch == null ? null : String(row.branch),
  placement:
    row.placement === "local" || row.placement === "cloud"
      ? row.placement
      : null,
  runtimeId: row.runtime_id == null ? null : String(row.runtime_id),
  runtimeStatus: row.runtime_status == null ? null : String(row.runtime_status),
});

export const makeProjectCatalog = async (options: {
  readonly dialect: "sqlite" | "mysql";
  readonly filename?: string;
  readonly mysqlUrl?: string;
}): Promise<ProjectCatalog> => {
  const db =
    options.dialect === "mysql"
      ? mysqlQueryable(createPool(options.mysqlUrl ?? ""))
      : sqliteQueryable(
          options.filename ?? join(".data", "project-worker", "catalog.db"),
        );
  if (options.dialect === "mysql") {
    for (const statement of statements("mysql")) await db.exec(statement);
  }
  const insertCommand =
    options.dialect === "mysql"
      ? `INSERT IGNORE INTO project_worker_commands (tenant_id, id, project_id, kind, body_json, state, error, created_ms) VALUES (?,?,?,?,?,'pending',NULL,?)`
      : `INSERT INTO project_worker_commands (tenant_id, id, project_id, kind, body_json, state, error, created_ms) VALUES (?,?,?,?,?,'pending',NULL,?) ON CONFLICT(tenant_id, id) DO NOTHING`;
  return {
    putProject: async (tenantId, project, config) => {
      const sql =
        options.dialect === "mysql"
          ? `INSERT INTO project_worker_projects (tenant_id, project_id, project_json, config_json) VALUES (?,?,?,?)
             ON DUPLICATE KEY UPDATE project_json=VALUES(project_json), config_json=VALUES(config_json)`
          : `INSERT INTO project_worker_projects (tenant_id, project_id, project_json, config_json) VALUES (?,?,?,?)
             ON CONFLICT(tenant_id, project_id) DO UPDATE SET project_json=excluded.project_json, config_json=excluded.config_json`;
      await db.run(sql, [
        tenantId,
        project.id,
        JSON.stringify(project),
        JSON.stringify(config),
      ]);
    },
    getProject: async (tenantId, projectId) => {
      const [row] = await db.all<Row>(
        "SELECT * FROM project_worker_projects WHERE tenant_id=? AND project_id=?",
        [tenantId, projectId],
      );
      return row ? projectFrom(row) : null;
    },
    listProjects: async (tenantId, cursor, limit) => {
      const rows = await db.all<Row>(
        "SELECT * FROM project_worker_projects WHERE tenant_id=? ORDER BY project_id LIMIT ? OFFSET ?",
        [tenantId, limit + 1, cursor],
      );
      return {
        data: rows.slice(0, limit).map(projectFrom),
        nextCursor: rows.length > limit ? cursor + limit : null,
      };
    },
    deleteProject: (tenantId, projectId) =>
      db.run(
        "DELETE FROM project_worker_projects WHERE tenant_id=? AND project_id=?",
        [tenantId, projectId],
      ),
    putCommand: async (command) => {
      const [before] = await db.all<Row>(
        "SELECT id FROM project_worker_commands WHERE tenant_id=? AND id=?",
        [command.tenantId, command.id],
      );
      await db.run(insertCommand, [
        command.tenantId,
        command.id,
        command.projectId,
        command.kind,
        JSON.stringify(command.body),
        Date.now(),
      ]);
      const [row] = await db.all<Row>(
        "SELECT * FROM project_worker_commands WHERE tenant_id=? AND id=?",
        [command.tenantId, command.id],
      );
      if (!row) throw new Error("Command was not stored");
      const stored = commandFrom(row);
      if (
        JSON.stringify(stored.body) !== JSON.stringify(command.body) ||
        stored.kind !== command.kind
      )
        return "conflict";
      return before ? "duplicate" : "inserted";
    },
    claimCommands: async (limit, now, leaseMs) => {
      const rows = await db.all<Row>(
        `SELECT * FROM project_worker_commands WHERE state IN ('pending','waiting') AND (lease_expires_ms IS NULL OR lease_expires_ms < ?) ORDER BY created_ms LIMIT ?`,
        [now, limit],
      );
      const claimed: StoredCommand[] = [];
      for (const row of rows) {
        await db.run(
          "UPDATE project_worker_commands SET state='pending', lease_expires_ms=? WHERE tenant_id=? AND id=? AND (lease_expires_ms IS NULL OR lease_expires_ms < ?)",
          [now + leaseMs, row.tenant_id, row.id, now],
        );
        claimed.push(commandFrom({ ...row, state: "pending" }));
      }
      return claimed;
    },
    completeCommand: (tenantId, id, error) =>
      db.run(
        "UPDATE project_worker_commands SET state='completed', error=?, lease_expires_ms=NULL WHERE tenant_id=? AND id=?",
        [error ?? null, tenantId, id],
      ),
    waitCommand: (tenantId, id, error, until) =>
      db.run(
        "UPDATE project_worker_commands SET state='waiting', error=?, lease_expires_ms=? WHERE tenant_id=? AND id=?",
        [error, until, tenantId, id],
      ),
    pendingCount: async (tenantId, projectId) => {
      const [row] = await db.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM project_worker_commands WHERE tenant_id=? AND project_id=? AND state IN ('pending','waiting')",
        [tenantId, projectId],
      );
      return Number(row?.n ?? 0);
    },
    lastError: async (tenantId, projectId) => {
      const [row] = await db.all<{ error: string | null }>(
        "SELECT error FROM project_worker_commands WHERE tenant_id=? AND project_id=? AND error IS NOT NULL ORDER BY created_ms DESC LIMIT 1",
        [tenantId, projectId],
      );
      return row?.error ?? null;
    },
    putCredential: (tenantId, ciphertext) => {
      const sql =
        options.dialect === "mysql"
          ? `INSERT INTO project_worker_credentials (tenant_id, ciphertext) VALUES (?,?) ON DUPLICATE KEY UPDATE ciphertext=VALUES(ciphertext)`
          : `INSERT INTO project_worker_credentials (tenant_id, ciphertext) VALUES (?,?) ON CONFLICT(tenant_id) DO UPDATE SET ciphertext=excluded.ciphertext`;
      return db.run(sql, [tenantId, ciphertext]);
    },
    getCredential: async (tenantId) => {
      const [row] = await db.all<{ ciphertext: string }>(
        "SELECT ciphertext FROM project_worker_credentials WHERE tenant_id=?",
        [tenantId],
      );
      return row?.ciphertext ?? null;
    },
    rememberThread: (tenantId, projectId, thread) => {
      const sql =
        options.dialect === "mysql"
          ? `INSERT INTO project_worker_threads (tenant_id, project_id, work_thread_id, role, session_id, creation_key, branch, placement, runtime_id, runtime_status)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE session_id=VALUES(session_id), branch=VALUES(branch), placement=VALUES(placement), runtime_id=VALUES(runtime_id), runtime_status=VALUES(runtime_status)`
          : `INSERT INTO project_worker_threads (tenant_id, project_id, work_thread_id, role, session_id, creation_key, branch, placement, runtime_id, runtime_status)
             VALUES (?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(tenant_id, project_id, work_thread_id) DO UPDATE SET
               session_id=excluded.session_id, branch=excluded.branch, placement=excluded.placement,
               runtime_id=excluded.runtime_id, runtime_status=excluded.runtime_status`;
      return db.run(sql, [
        tenantId,
        projectId,
        thread.workThreadId,
        thread.role,
        thread.sessionId,
        thread.creationKey,
        thread.branch,
        thread.placement,
        thread.runtimeId,
        thread.runtimeStatus,
      ]);
    },
    getThread: async (tenantId, projectId, workThreadId) => {
      const [row] = await db.all<Row>(
        "SELECT * FROM project_worker_threads WHERE tenant_id=? AND project_id=? AND work_thread_id=?",
        [tenantId, projectId, workThreadId],
      );
      return row ? threadFrom(row) : null;
    },
    listThreads: async (tenantId, projectId) =>
      (
        await db.all<Row>(
          "SELECT * FROM project_worker_threads WHERE tenant_id=? AND project_id=? ORDER BY work_thread_id",
          [tenantId, projectId],
        )
      ).map(threadFrom),
    recordUsage: (input) => {
      const sql =
        options.dialect === "mysql"
          ? `INSERT INTO project_worker_usage (tenant_id, project_id, work_thread_id, turn_id, tokens, seconds) VALUES (?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE tokens=VALUES(tokens), seconds=VALUES(seconds)`
          : `INSERT INTO project_worker_usage (tenant_id, project_id, work_thread_id, turn_id, tokens, seconds) VALUES (?,?,?,?,?,?)
             ON CONFLICT(tenant_id, project_id, work_thread_id, turn_id) DO UPDATE SET tokens=excluded.tokens, seconds=excluded.seconds`;
      return db.run(sql, [
        input.tenantId,
        input.projectId,
        input.workThreadId,
        input.turnId,
        input.tokens,
        input.seconds,
      ]);
    },
    usageTotal: async (tenantId, projectId) => {
      const [row] = await db.all<{ n: number }>(
        "SELECT COALESCE(SUM(tokens),0) AS n FROM project_worker_usage WHERE tenant_id=? AND project_id=?",
        [tenantId, projectId],
      );
      return Number(row?.n ?? 0);
    },
    recordGoalAudit: (goalId, turnId, empty) => {
      const sql =
        options.dialect === "mysql"
          ? `INSERT INTO project_worker_goal_audit (goal_id, turn_id, empty_turn) VALUES (?,?,?) ON DUPLICATE KEY UPDATE empty_turn=VALUES(empty_turn)`
          : `INSERT INTO project_worker_goal_audit (goal_id, turn_id, empty_turn) VALUES (?,?,?) ON CONFLICT(goal_id, turn_id) DO UPDATE SET empty_turn=excluded.empty_turn`;
      return db.run(sql, [goalId, turnId, empty ? 1 : 0]);
    },
    recentGoalAudit: async (goalId) =>
      (
        await db.all<{ empty_turn: number }>(
          "SELECT empty_turn FROM project_worker_goal_audit WHERE goal_id=? ORDER BY turn_id DESC LIMIT 3",
          [goalId],
        )
      ).map((row) => Number(row.empty_turn) === 1),
    resetGoalAudit: (goalId) =>
      db.run("DELETE FROM project_worker_goal_audit WHERE goal_id=?", [goalId]),
    releaseLeases: () =>
      db.run(
        "UPDATE project_worker_commands SET lease_expires_ms=NULL WHERE state IN ('pending','waiting')",
      ),
    close: () => db.close(),
  };
};

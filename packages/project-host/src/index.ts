export {
  projectWorkThreadId,
  type ProjectGoalInput,
  type ThreadGoal,
} from "./goals.js";
import {
  ProjectGoalRuntime,
  goalContinuationText,
  projectWorkThreadId,
  type ProjectGoalInput,
} from "./goals.js";
export {
  projectPromptAttachments,
  projectContextText,
  validateProjectAttachments,
  PROJECT_ATTACHMENT_LIMIT,
} from "./attachments.js";
export type { ProjectAttachment } from "./types.js";
export {
  projectStatus,
  type ProjectStatus,
  type ProjectStatusQuery,
  type ProjectStatusThread,
} from "./status.js";
import { validateProjectAttachments } from "./attachments.js";
export {
  ProjectWorkspaceRegistry,
  type ProjectWorkspaceBinding,
} from "./workspaces.js";
import { ProjectWorkspaceRegistry } from "./workspaces.js";
export type {
  ProjectWorkConfig,
  ProjectWorkCommand,
  ProjectWorkView,
} from "./types.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { makeSqliteStore } from "@openmatter/store-sqlite";
import { makeSqliteInbox } from "@openmatter/inbox-sqlite";
import {
  createOpenMatter,
  type OpenMatterApplication,
} from "@openmatter/runtime";
import {
  coordinatorLoop,
  type CoordinatorAssociation,
} from "@openmatter/orchestration";
import {
  makeProjectControl,
  makeProjectIntegration,
  projectCommandSinkFromInbox,
  associateProjectEvent,
  PROJECT_WORK_EVENT_TYPES,
  ProjectControlError,
} from "@openmatter/project";
import type { AgentDriver } from "@openmatter/agent";
import type { WorkEvent, JsonValue, ThreadGoal } from "@openmatter/core";
import type { InboxClaim } from "@openmatter/inbox";
import type {
  ProjectWorkConfig,
  ProjectWorkCommand,
  ProjectWorkView,
} from "./types.js";

export interface ProjectWorkDeps<
  TProject extends { id: string; name: string },
> {
  directory: string;
  getProject(id: string): TProject | null;
  driver(
    id: string,
    project: TProject,
    role: "coordinator" | "worker",
    config: ProjectWorkConfig,
  ): AgentDriver;
}
/** Host configuration and durable inbox delivery. All work executes inside OpenMatter. */
export class ProjectWorkService<TProject extends { id: string; name: string }> {
  readonly db: DatabaseSync;
  readonly workspaces: ProjectWorkspaceRegistry;
  readonly store;
  readonly inbox;
  readonly #goals: ProjectGoalRuntime;
  readonly #deps: ProjectWorkDeps<TProject>;
  readonly #apps = new Map<string, OpenMatterApplication>();
  readonly #inflight = new Set<Promise<void>>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #claiming = false;
  #closed = false;
  constructor(deps: ProjectWorkDeps<TProject>) {
    this.#deps = deps;
    mkdirSync(deps.directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(deps.directory, "projects.db"));
    this.workspaces = new ProjectWorkspaceRegistry(this.db);
    this.store = makeSqliteStore({ database: this.db });
    this.#goals = new ProjectGoalRuntime(this.store, this.db);
    this.inbox = makeSqliteInbox({
      filename: join(deps.directory, "project-inbox.db"),
    });
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS openmatter_project_config(project_id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS openmatter_project_commands(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL, state TEXT NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS openmatter_project_commands_project ON openmatter_project_commands(project_id,state);`);
  }
  config(id: string): ProjectWorkConfig | null {
    const row = this.db
      .prepare("SELECT data FROM openmatter_project_config WHERE project_id=?")
      .get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }
  async save(config: ProjectWorkConfig): Promise<ProjectWorkConfig> {
    this.#project(config.projectId);
    if (
      typeof config.coordinatorAgent !== "string" ||
      typeof config.workerAgent !== "string"
    )
      throw new Error("Invalid agent selection");
    if (!!config.coordinatorAgent.trim() !== !!config.workerAgent.trim())
      throw new Error("Choose both agents, or leave both empty for a draft");
    if (!["per-scope", "per-run"].includes(config.continuity))
      throw new Error("Invalid continuity");
    if (
      !Array.isArray(config.controls) ||
      config.controls.some(
        (c) => !["delegate", "steer", "cancel", "complete"].includes(c),
      )
    )
      throw new Error("Invalid controls");
    if (
      !Array.isArray(config.resources) ||
      config.resources.length > 30 ||
      config.resources.some(
        (r) => !r.id || !r.name || typeof r.text !== "string",
      )
    )
      throw new Error("Invalid project resources");
    for (const value of [
      config.instructions,
      config.context,
      config.description,
    ])
      if (typeof value !== "string") throw new Error("Invalid project text");
    if (
      config.baseRef !== undefined &&
      (typeof config.baseRef !== "string" || config.baseRef.length > 256)
    )
      throw new Error("Invalid base reference");
    if (config.repositories !== undefined) {
      if (!Array.isArray(config.repositories) || config.repositories.length > 8)
        throw new Error("Choose up to eight repositories");
      for (const repo of config.repositories) {
        if (
          typeof repo.url !== "string" ||
          repo.url.length > 2048 ||
          (repo.baseRef !== undefined &&
            (typeof repo.baseRef !== "string" || repo.baseRef.length > 256))
        )
          throw new Error("Invalid repository configuration");
        const url = new URL(repo.url);
        if (
          url.protocol !== "https:" ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          throw new Error("Use an HTTPS repository URL without credentials");
      }
    }
    if (JSON.stringify(config).length > 512_000)
      throw new Error("Project context must be under 512 KB");
    if (this.#pending(config.projectId))
      throw new Error(
        "Wait for pending project work before changing its configuration",
      );
    this.db
      .prepare(
        "INSERT INTO openmatter_project_config VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data",
      )
      .run(config.projectId, JSON.stringify(config));
    this.#apps.delete(config.projectId);
    return this.config(config.projectId)!;
  }
  #project(id: string) {
    const p = this.#deps.getProject(id);
    if (!p) throw new Error("Unknown project");
    return p;
  }
  #reconcile() {
    // The durable inbox is authoritative. Repair the host's query index after a
    // crash between queue writes and metadata writes (the two use separate DBs).
    for (const entry of Effect.runSync(this.inbox.inspect)) {
      const body = entry.item.body as Record<string, unknown>;
      const isControl = entry.item.integrationId === "project";
      const id = isControl
        ? String(body.scopeId)
        : String((body.source as { conversationId: string }).conversationId);
      const payload = body.payload as {
        text: string;
        runId?: string;
        attachments?: import("./types.js").ProjectAttachment[];
      };
      const command = isControl
        ? body
        : {
            projectId: id,
            commandId: entry.item.id.slice(`${id}:message:`.length),
            type: "message",
            text: payload.text,
            ...(payload.attachments?.length
              ? { attachments: payload.attachments }
              : {}),
            ...(payload.runId ? { runId: payload.runId } : {}),
          };
      this.db
        .prepare(
          "INSERT INTO openmatter_project_commands VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,error=excluded.error",
        )
        .run(
          entry.item.id,
          id,
          JSON.stringify(command),
          entry.state === "completed" ? "completed" : "pending",
          entry.error,
        );
    }
  }
  #pending(id: string) {
    this.#reconcile();
    return Number(
      (
        this.db
          .prepare(
            "SELECT count(*) AS n FROM openmatter_project_commands WHERE project_id=? AND state='pending'",
          )
          .get(id) as { n: number }
      ).n,
    );
  }
  async view(id: string): Promise<ProjectWorkView<TProject>> {
    const project = this.#project(id);
    this.#reconcile();
    const error = this.db
      .prepare(
        "SELECT error FROM openmatter_project_commands WHERE project_id=? AND error IS NOT NULL ORDER BY rowid DESC LIMIT 1",
      )
      .get(id) as { error: string } | undefined;
    return {
      project,
      config: this.config(id),
      facts: await Effect.runPromise(this.store.inspectScope(id)),
      workspaces: this.workspaces.list(id),
      pending: this.#pending(id),
      error: error?.error ?? null,
    };
  }
  /** The tool binding supplies business scope; models cannot choose another project. */
  control(projectId: string, runId?: string, commandId?: string) {
    this.#reconcile();
    const config = this.config(projectId);
    this.#project(projectId);
    if (!config) throw new Error("Configure this project first");
    if (!config.coordinatorAgent.trim() || !config.workerAgent.trim())
      throw new Error("Choose both agents before starting work");
    if (config.continuity === "per-run" && !runId)
      throw new Error("Choose an isolated run");
    const sink = projectCommandSinkFromInbox(this.inbox);
    return makeProjectControl({
      scopeId: projectId,
      authority: "project-host",
      ...(runId ? { runId } : {}),
      ...(commandId ? { makeId: () => commandId } : {}),
      sink: {
        publish: (command) =>
          Effect.tryPromise({
            try: async () => {
              const type =
                command.type === "worker.requested"
                  ? "delegate"
                  : command.type === "worker.steered"
                    ? "steer"
                    : command.type === "worker.cancel.requested"
                      ? "cancel"
                      : "complete";
              if (!this.config(projectId)?.controls.includes(type))
                throw new Error("This control is not enabled");
              const existing = this.db
                .prepare(
                  "SELECT data FROM openmatter_project_commands WHERE id=?",
                )
                .get(command.idempotencyKey) as { data: string } | undefined;
              if (existing) {
                const previous = JSON.parse(existing.data);
                if (
                  previous.type !== command.type ||
                  JSON.stringify(previous.payload) !==
                    JSON.stringify(command.payload) ||
                  previous.runId !== command.runId
                )
                  throw new Error("Command ID was reused for different input");
                return "duplicate" as const;
              }
              const result = await Effect.runPromise(sink.publish(command));
              this.db
                .prepare(
                  "INSERT OR IGNORE INTO openmatter_project_commands VALUES(?,?,?,'pending',NULL)",
                )
                .run(
                  command.idempotencyKey,
                  projectId,
                  JSON.stringify(command),
                );
              return result;
            },
            catch: (cause) =>
              new ProjectControlError({
                message: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
          }),
      },
    });
  }
  async submit(input: ProjectWorkCommand): Promise<void> {
    this.#reconcile();
    validateProjectAttachments(input.attachments);
    if (
      input.attachments?.length &&
      !["message", "delegate", "steer"].includes(input.type)
    )
      throw new Error(
        "Attachments are only supported on messages and worker instructions",
      );
    const project = this.#project(input.projectId);
    const config = this.config(project.id);
    if (!config) throw new Error("Configure this project first");
    if (!config.coordinatorAgent.trim() || !config.workerAgent.trim())
      throw new Error("Choose both agents before starting work");
    if (
      !["message", "delegate", "steer", "cancel", "complete"].includes(
        input.type,
      )
    )
      throw new Error("Invalid project command");
    if (
      typeof input.commandId !== "string" ||
      typeof input.text !== "string" ||
      !input.commandId.trim() ||
      (!input.text?.trim() && !input.attachments?.length) ||
      input.text.length > 100_000
    )
      throw new Error("Enter a message under 100 KB");
    if (config.continuity === "per-run" && !input.runId?.trim())
      throw new Error("Choose an isolated run");
    if (input.type === "message") {
      const id = `${project.id}:message:${input.commandId}`;
      const existing = this.db
        .prepare("SELECT data FROM openmatter_project_commands WHERE id=?")
        .get(id) as { data: string } | undefined;
      if (existing) {
        if (
          (() => {
            const p = JSON.parse(existing.data);
            return (
              p.projectId !== input.projectId ||
              p.type !== input.type ||
              p.text !== input.text ||
              JSON.stringify(
                (p.attachments ?? []).map(
                  (f: import("./types.js").ProjectAttachment) => [
                    f.id,
                    f.name,
                    f.kind,
                    f.mimeType,
                    f.data,
                  ],
                ),
              ) !==
                JSON.stringify(
                  (input.attachments ?? []).map((f) => [
                    f.id,
                    f.name,
                    f.kind,
                    f.mimeType,
                    f.data,
                  ]),
                ) ||
              p.runId !== input.runId
            );
          })()
        )
          throw new Error("Message ID was reused for different input");
        return;
      }
      const at = new Date().toISOString();
      const event: WorkEvent = {
        schemaVersion: "0.1",
        id,
        idempotencyKey: id,
        type: "project.message",
        occurredAt: at,
        receivedAt: at,
        source: {
          provider: "project",
          authority: "project-host",
          conversationId: project.id,
        },
        payload: {
          text: input.text,
          ...(input.attachments?.length
            ? { attachments: input.attachments }
            : {}),
          ...(input.runId ? { runId: input.runId } : {}),
        },
      };
      await Effect.runPromise(
        this.inbox.enqueue({
          id,
          idempotencyKey: id,
          integrationId: "project-host",
          eventType: event.type,
          body: event as unknown as JsonValue,
          receivedAt: at,
        }),
      );
      this.db
        .prepare(
          "INSERT OR IGNORE INTO openmatter_project_commands VALUES(?,?,?,'pending',NULL)",
        )
        .run(id, project.id, JSON.stringify(input));
    } else {
      if (!config.controls.includes(input.type))
        throw new Error("This control is not enabled");
      const control = this.control(
        project.id,
        input.runId,
        `${project.id}:${input.commandId}`,
      );
      if (input.type !== "complete" && !input.workerId?.trim())
        throw new Error("Choose a worker ID");
      const workerId = input.workerId ?? "";
      const effect =
        input.type === "delegate"
          ? control.delegate({
              workerId,
              task: input.text || "Review the attached files.",
              ...(input.attachments ? { attachments: input.attachments } : {}),
            })
          : input.type === "steer"
            ? control.steer({
                workerId,
                instruction: input.text || "Review the attached files.",
                ...(input.attachments
                  ? { attachments: input.attachments }
                  : {}),
              })
            : input.type === "cancel"
              ? control.cancel({ workerId, reason: input.text })
              : control.complete({ summary: input.text });
      await Effect.runPromise(effect);
    }
  }
  #goalAssociation(
    projectId: string,
    workThreadId: string,
  ): CoordinatorAssociation {
    this.#project(projectId);
    const config = this.config(projectId);
    if (!config) throw new Error("Configure this project first");
    if (
      config.continuity === "per-scope" &&
      workThreadId === projectWorkThreadId(projectId)
    ) {
      return {
        scopeId: projectId,
        thread: { kind: "coordinator" },
        authority: "project-host",
      };
    }
    const facts = Effect.runSync(this.store.inspectScope(projectId));
    const context = [...facts.contexts]
      .reverse()
      .find((item) => item.workThreadId === workThreadId);
    const value = context?.items.find(
      (item) => item.kind === "coordinator-association",
    )?.value as
      | { scopeId?: string; role?: string; runId?: string; workerId?: string }
      | undefined;
    if (
      !value ||
      value.scopeId !== projectId ||
      !["coordinator", "worker"].includes(value.role ?? "")
    )
      throw new Error("Unknown project work thread");
    return {
      scopeId: projectId,
      authority: "project-host",
      ...(value.runId ? { runId: value.runId } : {}),
      thread:
        value.role === "worker"
          ? { kind: "worker", id: value.workerId! }
          : { kind: "coordinator" },
    };
  }
  async setGoal(input: ProjectGoalInput): Promise<ThreadGoal | null> {
    this.#goalAssociation(input.projectId, input.workThreadId);
    if (
      input.status !== undefined &&
      !["active", "paused"].includes(input.status)
    )
      throw new Error("Invalid host goal status");
    const existing = Effect.runSync(
      this.store.getThreadGoal(input.workThreadId),
    );
    if (existing && existing.scopeId !== input.projectId)
      throw new Error("Goal project mismatch");
    if (
      existing?.status === "complete" &&
      input.status === "active" &&
      input.objective === undefined
    )
      throw new Error("Start a new outcome with a new objective");
    if (input.clear) {
      Effect.runSync(
        this.store.clearThreadGoal(input.workThreadId, existing?.id),
      );
      if (existing) this.#goals.resetAudit(existing.id);
      return null;
    }
    if (
      !existing ||
      (existing.status === "complete" && input.objective !== undefined)
    ) {
      if (!input.objective) throw new Error("Enter a goal objective");
      return Effect.runSync(
        this.store.createThreadGoal({
          scopeId: input.projectId,
          workThreadId: input.workThreadId,
          objective: input.objective,
          ...(input.tokenBudget == null
            ? {}
            : { tokenBudget: input.tokenBudget }),
        }),
      );
    }
    if (input.status === "active") this.#goals.resetAudit(existing.id);
    return Effect.runSync(
      this.store.updateThreadGoal(input.workThreadId, {
        expectedGoalId: existing.id,
        expectedRevision: existing.revision,
        ...(input.objective === undefined
          ? {}
          : { objective: input.objective }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.tokenBudget === undefined
          ? {}
          : { tokenBudget: input.tokenBudget }),
      }),
    );
  }
  goalControl(projectId: string, workThreadId: string) {
    const check = () => this.#goalAssociation(projectId, workThreadId);
    return {
      get: async (): Promise<ThreadGoal | null> => {
        check();
        return Effect.runSync(this.store.getThreadGoal(workThreadId)) ?? null;
      },
      create: async (input: {
        objective: string;
        tokenBudget?: number;
      }): Promise<ThreadGoal> => {
        check();
        return Effect.runSync(
          this.store.createThreadGoal({
            scopeId: projectId,
            workThreadId,
            ...input,
          }),
        );
      },
      update: async (input: {
        status: "complete" | "blocked";
        reason?: string;
      }): Promise<ThreadGoal> => {
        check();
        if (!["complete", "blocked"].includes(input.status))
          throw new Error("Models may only mark goals complete or blocked");
        const goal = Effect.runSync(this.store.getThreadGoal(workThreadId));
        if (!goal) throw new Error("No goal is set");
        if (goal.status !== "active")
          throw new Error("This goal is not active");
        return Effect.runSync(
          this.store.updateThreadGoal(workThreadId, {
            expectedGoalId: goal.id,
            expectedRevision: goal.revision,
            ...input,
          }),
        );
      },
    };
  }
  #admitGoal(event: WorkEvent): boolean {
    if (event.type !== "project.goal.continue") return true;
    const payload = event.payload as {
      workThreadId: string;
      goalId: string;
      revision: number;
    };
    const goal = Effect.runSync(this.store.getThreadGoal(payload.workThreadId));
    return (
      goal !== undefined &&
      goal.scopeId === event.source.conversationId &&
      goal.id === payload.goalId &&
      goal.revision === payload.revision &&
      goal.status === "active"
    );
  }
  async #scheduleGoals() {
    const goals = Effect.runSync(this.store.listThreadGoals()).filter(
      (goal) => goal.status === "active",
    );
    const scopes = new Set(goals.map((goal) => goal.scopeId));
    for (const scopeId of scopes) {
      // User commands and worker-result turns take precedence over automatic work.
      if (this.#pending(scopeId)) continue;
      const facts = Effect.runSync(this.store.inspectScope(scopeId));
      const scoped = goals.filter((goal) => goal.scopeId === scopeId);
      const runningWorkThreads = new Set(
        facts.turns
          .filter((turn) => turn.state === "queued" || turn.state === "running")
          .map(
            (turn) =>
              facts.sessions.find((session) => session.id === turn.sessionId)
                ?.workThreadId,
          )
          .filter((id): id is string => !!id),
      );
      for (const goal of scoped) {
        if (runningWorkThreads.has(goal.workThreadId)) continue;
        const association = this.#goalAssociation(scopeId, goal.workThreadId);
        const sessions = facts.sessions.filter(
          (session) => session.workThreadId === goal.workThreadId,
        );
        const last = facts.turns
          .filter((turn) =>
            sessions.some((session) => session.id === turn.sessionId),
          )
          .at(-1);
        const id = `goal:${goal.id}:${goal.revision}:${last?.id ?? "start"}`;
        const at = new Date().toISOString();
        const event: WorkEvent = {
          schemaVersion: "0.1",
          id,
          idempotencyKey: id,
          type: "project.goal.continue",
          occurredAt: at,
          receivedAt: at,
          source: {
            provider: "project",
            authority: "project-host",
            conversationId: scopeId,
            ...(association.thread.kind === "worker"
              ? { threadId: association.thread.id }
              : {}),
          },
          payload: {
            workThreadId: goal.workThreadId,
            goalId: goal.id,
            revision: goal.revision,
            text: goalContinuationText(goal),
            ...(association.runId ? { runId: association.runId } : {}),
          },
        };
        await Effect.runPromise(
          this.inbox.enqueue({
            id,
            idempotencyKey: id,
            integrationId: "project-host",
            eventType: event.type,
            body: event as unknown as JsonValue,
            receivedAt: at,
          }),
        );
      }
    }
  }
  #app(id: string) {
    const cached = this.#apps.get(id);
    if (cached) return cached;
    const project = this.#project(id),
      config = this.config(id);
    if (!config) throw new Error("Project is not configured");
    const app = createOpenMatter({
      store: this.store,
      integrations: { project: makeProjectIntegration() },
      agents: {
        coordinator: this.#deps.driver(
          config.coordinatorAgent,
          project,
          "coordinator",
          config,
        ),
        worker: this.#deps.driver(
          config.workerAgent,
          project,
          "worker",
          config,
        ),
      },
    })
      .loop(
        coordinatorLoop({
          id: `project:${id}`,
          continuity: config.continuity,
          agentId: "coordinator",
          workerAgent: "worker",
          sources: [
            "project.message",
            "project.goal.continue",
            ...PROJECT_WORK_EVENT_TYPES.filter(
              (t) => t !== "project.completed",
            ),
          ],
          cancelSources: ["project.worker.cancel.requested"],
          controls: config.controls,
          associate: associateProjectEvent,
          admit: ({ work }) => this.#admitGoal(work.event),
          onTurnFinished: ({ context, turn }) =>
            this.#goals.afterTurn(context, turn),
          context: ({ work, association }) => [
            ...(() => {
              const workThreadId = projectWorkThreadId(
                id,
                config.continuity === "per-run" ? association.runId : undefined,
                association.thread.kind === "worker"
                  ? association.thread.id
                  : undefined,
              );
              const goal = Effect.runSync(
                this.store.getThreadGoal(workThreadId),
              );
              const payload = work.event.payload as { workThreadId?: string };
              return [
                ...(goal
                  ? [
                      work.context.value({
                        id: `${workThreadId}:goal`,
                        kind: "thread-goal",
                        value: goal as unknown as JsonValue,
                        provenance: [{ sourceType: "goal", sourceId: goal.id }],
                      }),
                    ]
                  : []),
                ...(work.event.type === "project.goal.continue" &&
                payload.workThreadId === workThreadId
                  ? [
                      work.context.value({
                        id: `${work.event.id}:continuation`,
                        kind: "goal-continuation",
                        value: (work.event.payload ?? {}) as JsonValue,
                        provenance: [
                          { sourceType: "work-event", sourceId: work.event.id },
                        ],
                      }),
                    ]
                  : []),
              ];
            })(),
            work.context.value({
              id: `${id}:workspaces`,
              kind: "project-workspaces",
              value: this.workspaces.list(id) as unknown as JsonValue,
              provenance: [{ sourceType: "project", sourceId: id }],
            }),
            work.context.value({
              id: `${id}:instructions`,
              kind: "project-instructions",
              value: {
                goal: config.description,
                instructions: config.instructions,
              },
              provenance: [{ sourceType: "project", sourceId: id }],
            }),
            work.context.value({
              id: `${id}:context`,
              kind: "project-context",
              value: config.context,
              provenance: [{ sourceType: "project", sourceId: id }],
            }),
            ...config.resources.map((r) =>
              work.context.value({
                id: r.id,
                kind: "project-resource",
                value: { name: r.name, text: r.text },
                provenance: [
                  { sourceType: "project-resource", sourceId: r.id },
                ],
              }),
            ),
          ],
        }),
      )
      .on("project.completed", (work) =>
        work.react.none("Project completed by explicit control"),
      );
    this.#apps.set(id, app);
    return app;
  }
  async #deliver(claim: InboxClaim) {
    const body = claim.item.body as Record<string, unknown>;
    const id =
      claim.item.integrationId === "project"
        ? String(body.scopeId)
        : String((body.source as { conversationId: string }).conversationId);
    let renewalError: unknown;
    const renew = setInterval(() => {
      void Effect.runPromise(
        this.inbox.renew(claim.item.id, claim.lease.token, {
          durationMs: 30_000,
        }),
      ).catch((e) => {
        renewalError = e;
      });
    }, 10_000);
    renew.unref();
    try {
      const app = this.#app(id);
      if (claim.item.integrationId === "project")
        await app.acceptFrom("project", claim.item.body);
      else await app.accept(claim.item.body as unknown as WorkEvent);
      if (renewalError) throw renewalError;
      await Effect.runPromise(
        this.inbox.complete(claim.item.id, claim.lease.token),
      );
      this.db
        .prepare(
          "UPDATE openmatter_project_commands SET state='completed',error=NULL WHERE id=?",
        )
        .run(claim.item.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db
        .prepare("UPDATE openmatter_project_commands SET error=? WHERE id=?")
        .run(message, claim.item.id);
      await Effect.runPromise(
        this.inbox.retry(claim.item.id, claim.lease.token, {
          delayMs: Math.min(60_000, 1000 * 2 ** Math.min(claim.attempt - 1, 6)),
          error: message,
        }),
      );
    } finally {
      clearInterval(renew);
    }
  }
  async drain(): Promise<void> {
    if (this.#closed || this.#claiming) return;
    this.#claiming = true;
    try {
      await this.#scheduleGoals();
      const claims = await Effect.runPromise(
        this.inbox.claim({
          ownerId: "project-host",
          durationMs: 30_000,
          limit: 8,
        }),
      );
      for (const claim of claims) {
        const task = this.#deliver(claim).finally(() =>
          this.#inflight.delete(task),
        );
        this.#inflight.add(task);
      }
    } finally {
      this.#claiming = false;
    }
    await Promise.all([...this.#inflight]);
  }
  start() {
    if (!this.#timer) {
      this.#timer = setInterval(() => {
        void this.drain().catch(() => {});
      }, 500);
      this.#timer.unref();
      void this.drain();
    }
  }
  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    await Promise.allSettled([...this.#inflight]);
    await Effect.runPromise(this.inbox.close);
    await Effect.runPromise(this.store.close);
    this.db.close();
  }
}

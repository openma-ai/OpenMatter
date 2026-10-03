import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { coordinatorLoop } from "@openmatter/orchestration";
import { Effect } from "effect";
import type { JsonValue, ThreadGoal, WorkEvent } from "@openmatter/core";
import {
  associateProjectEvent,
  makeMemoryProjectCommandSink,
  makeProjectControl,
  makeProjectIntegration,
  PROJECT_WORK_EVENT_TYPES,
} from "@openmatter/project";
import {
  goalContinuationText,
  goalTurnTokens,
  projectWorkThreadId,
  validateProjectAttachments,
  type ProjectGoalInput,
  type ProjectWorkCommand,
  type ProjectWorkConfig,
  type ProjectWorkView,
} from "@openmatter/project-host";
import {
  createOpenMatter,
  type OpenMatterApplication,
} from "@openmatter/runtime";
import type { MysqlStore } from "@openmatter/store-mysql";
import { makeMysqlStore } from "@openmatter/store-mysql";
import type { SqliteStore } from "@openmatter/store-sqlite";
import { makeSqliteStore } from "@openmatter/store-sqlite";
import {
  makeProjectCatalog,
  type ProjectCatalog,
  type StoredProject,
} from "./catalog.js";
import type { WorkerConfig } from "./config.js";
import { ensureGithubBranch } from "./github.js";
import { makeOmaClient, makeOmaDriver, type OmaClient } from "./oma.js";
import { openSecret, sealSecret } from "./secrets.js";

type TenantStore = SqliteStore | MysqlStore;

const safeTenant = (tenantId: string) =>
  tenantId.replace(/[^A-Za-z0-9._-]/g, "_");

export class ProjectWorker {
  readonly catalog: Promise<ProjectCatalog>;
  readonly #stores = new Map<string, TenantStore>();
  readonly #apps = new Map<string, OpenMatterApplication>();
  readonly #client: OmaClient;
  #timer: ReturnType<typeof setInterval> | undefined;
  #draining = false;
  #closed = false;
  readonly #abort = new AbortController();

  constructor(
    readonly config: WorkerConfig,
    readonly client?: OmaClient,
  ) {
    this.#client =
      client ??
      makeOmaClient({ baseUrl: config.openmaUrl, signal: this.#abort.signal });
    mkdirSync(config.dataDir, { recursive: true });
    this.catalog = makeProjectCatalog(
      config.store === "mysql"
        ? { dialect: "mysql", mysqlUrl: config.mysqlUrl ?? "" }
        : { dialect: "sqlite", filename: join(config.dataDir, "catalog.db") },
    );
  }

  storeFor(tenantId: string): TenantStore {
    const cached = this.#stores.get(tenantId);
    if (cached) return cached;
    const directory = join(
      this.config.dataDir,
      "tenants",
      safeTenant(tenantId),
    );
    if (this.config.store === "sqlite")
      mkdirSync(directory, { recursive: true });
    const store =
      this.config.store === "mysql"
        ? makeMysqlStore({ tenantId, url: this.config.mysqlUrl ?? "" })
        : makeSqliteStore({ filename: join(directory, "store.db") });
    this.#stores.set(tenantId, store);
    return store;
  }

  verifyTenant(apiKey: string, tenantId: string) {
    return this.#client.request(apiKey, tenantId, "/v1/oma/me");
  }

  async rememberKey(tenantId: string, apiKey: string) {
    const catalog = await this.catalog;
    await catalog.putCredential(
      tenantId,
      sealSecret(this.config.credentialKey, apiKey),
    );
  }

  async apiKey(tenantId: string): Promise<string> {
    const sealed = await (await this.catalog).getCredential(tenantId);
    if (!sealed)
      throw new Error("This tenant has no OpenMA credential on the worker");
    return openSecret(this.config.credentialKey, sealed);
  }

  async save(
    tenantId: string,
    project: StoredProject["project"],
    config: ProjectWorkConfig,
  ) {
    this.#validate(config);
    if (project.id !== config.projectId)
      throw new Error("Project id does not match");
    await (await this.catalog).putProject(tenantId, project, config);
    this.#apps.delete(`${tenantId}:${project.id}`);
    return (await this.view(tenantId, project.id)).config!;
  }

  async view(
    tenantId: string,
    projectId: string,
  ): Promise<
    ProjectWorkView & {
      remoteSessions: Array<{
        workThreadId: string;
        role: string;
        sessionId: string | null;
        placement: string | null;
        runtimeStatus: string | null;
        branch: string | null;
      }>;
    }
  > {
    const catalog = await this.catalog;
    const stored = await catalog.getProject(tenantId, projectId);
    if (!stored) throw new Error("Unknown project");
    const facts = await Effect.runPromise(
      this.storeFor(tenantId).inspectScope(projectId),
    );
    const threads = await catalog.listThreads(tenantId, projectId);
    return {
      project: stored.project,
      config: stored.config,
      facts,
      workspaces: threads.map((thread) => ({
        id: thread.workThreadId,
        projectId,
        workThreadId: thread.workThreadId,
        branch: thread.branch ?? "",
        spec: { repositories: stored.config.repositories ?? [] },
        location: thread.sessionId
          ? {
              sessionId: thread.sessionId,
              placement: thread.placement,
              runtimeStatus: thread.runtimeStatus,
            }
          : null,
      })),
      pending: await catalog.pendingCount(tenantId, projectId),
      error: await catalog.lastError(tenantId, projectId),
      remoteSessions: threads.map((thread) => ({
        workThreadId: thread.workThreadId,
        role: thread.role,
        sessionId: thread.sessionId,
        placement: thread.placement,
        runtimeStatus: thread.runtimeStatus,
        branch: thread.branch,
      })),
    };
  }

  async list(tenantId: string, cursor = 0, limit = 20) {
    const page = await (
      await this.catalog
    ).listProjects(tenantId, cursor, Math.min(limit, 50));
    return { data: page.data, nextCursor: page.nextCursor };
  }

  async remove(tenantId: string, projectId: string) {
    const catalog = await this.catalog;
    if (!(await catalog.getProject(tenantId, projectId)))
      throw new Error("Unknown project");
    if (await catalog.pendingCount(tenantId, projectId))
      throw new Error(
        "Wait for pending project work before deleting the project",
      );
    await catalog.deleteProject(tenantId, projectId);
    this.#apps.delete(`${tenantId}:${projectId}`);
  }

  async submit(tenantId: string, input: ProjectWorkCommand) {
    validateProjectAttachments(input.attachments);
    const catalog = await this.catalog;
    const stored = await catalog.getProject(tenantId, input.projectId);
    if (!stored) throw new Error("Unknown project");
    if (
      !stored.config.coordinatorAgent.trim() ||
      !stored.config.workerAgent.trim()
    )
      throw new Error("Choose both agents before starting work");
    const id =
      input.type === "message"
        ? `${input.projectId}:message:${input.commandId}`
        : `project-command:${input.projectId}:${input.commandId}`;
    const body = await this.#commandBody(stored, input, id);
    const result = await catalog.putCommand({
      id,
      tenantId,
      projectId: input.projectId,
      kind: input.type === "message" ? "event" : "project",
      body,
      state: "pending",
      error: null,
    });
    if (result === "conflict")
      throw new Error("Command ID was reused for different input");
    void this.drain();
  }

  async setGoal(
    tenantId: string,
    input: ProjectGoalInput,
  ): Promise<ThreadGoal | null> {
    const catalog = await this.catalog;
    if (!(await catalog.getProject(tenantId, input.projectId)))
      throw new Error("Unknown project");
    if (
      input.status !== undefined &&
      !["active", "paused"].includes(input.status)
    )
      throw new Error("Invalid host goal status");
    const store = this.storeFor(tenantId);
    const existing = await Effect.runPromise(
      store.getThreadGoal(input.workThreadId),
    );
    if (existing && existing.scopeId !== input.projectId)
      throw new Error("Goal project mismatch");
    if (input.clear) {
      await Effect.runPromise(
        store.clearThreadGoal(input.workThreadId, existing?.id),
      );
      if (existing) await catalog.resetGoalAudit(existing.id);
      return null;
    }
    if (
      !existing ||
      (existing.status === "complete" && input.objective !== undefined)
    ) {
      if (!input.objective) throw new Error("Enter a goal objective");
      return Effect.runPromise(
        store.createThreadGoal({
          scopeId: input.projectId,
          workThreadId: input.workThreadId,
          objective: input.objective,
          ...(input.tokenBudget == null
            ? {}
            : { tokenBudget: input.tokenBudget }),
        }),
      );
    }
    if (input.status === "active") await catalog.resetGoalAudit(existing.id);
    return Effect.runPromise(
      store.updateThreadGoal(input.workThreadId, {
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

  async drain() {
    if (this.#draining) return;
    this.#draining = true;
    try {
      const catalog = await this.catalog;
      const claims = await catalog.claimCommands(4, Date.now(), 30_000);
      for (const claim of claims) {
        try {
          await this.#assertQuota(claim.tenantId, claim.projectId);
          const app = await this.#app(claim.tenantId, claim.projectId);
          const receipt =
            claim.kind === "project"
              ? await app.acceptFrom("project", claim.body)
              : [await app.accept(claim.body as unknown as WorkEvent)];
          const failed = receipt.find(
            (item) => item.reaction.status === "failed",
          );
          if (failed)
            throw new Error(failed.reaction.reason ?? "Project turn failed");
          await catalog.completeCommand(claim.tenantId, claim.id);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (this.#closed) return;
          if (message.includes("offline"))
            await catalog.waitCommand(
              claim.tenantId,
              claim.id,
              message,
              Date.now() + 5_000,
            );
          else if (this.#abort.signal.aborted || message.includes("aborted"))
            await catalog.waitCommand(
              claim.tenantId,
              claim.id,
              message,
              Date.now(),
            );
          else await catalog.completeCommand(claim.tenantId, claim.id, message);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.drain(), 250);
    this.#timer.unref?.();
    void this.drain();
  }

  async close() {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#abort.abort();
    while (this.#draining)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const catalog = await this.catalog;
    await catalog.releaseLeases();
    await Promise.all(
      [...this.#stores.values()].map((store) => Effect.runPromise(store.close)),
    );
    this.#stores.clear();
    await catalog.close();
  }

  async #assertQuota(tenantId: string, projectId: string) {
    if (this.config.tokenQuota === undefined) return;
    const used = await (await this.catalog).usageTotal(tenantId, projectId);
    if (used >= this.config.tokenQuota)
      throw new Error(
        "Usage quota exceeded. This thread is paused and no new turn was started.",
      );
  }

  async #commandBody(
    stored: StoredProject,
    input: ProjectWorkCommand,
    id: string,
  ): Promise<JsonValue> {
    if (input.type === "message") {
      const at = new Date().toISOString();
      return {
        schemaVersion: "0.1",
        id,
        idempotencyKey: id,
        type: "project.message",
        occurredAt: at,
        receivedAt: at,
        source: {
          provider: "project",
          authority: "project-host",
          conversationId: stored.project.id,
        },
        payload: {
          text: input.text,
          ...(input.attachments?.length
            ? { attachments: input.attachments }
            : {}),
          ...(input.runId ? { runId: input.runId } : {}),
        },
      } as unknown as JsonValue;
    }
    if (!stored.config.controls.includes(input.type))
      throw new Error("This control is not enabled");
    const sink = makeMemoryProjectCommandSink();
    const control = makeProjectControl({
      scopeId: stored.project.id,
      authority: "project-host",
      ...(input.runId ? { runId: input.runId } : {}),
      makeId: () => `${stored.project.id}:${input.commandId}`,
      sink,
      clock: () => new Date().toISOString(),
    });
    const workerId = input.workerId ?? "";
    if (input.type !== "complete" && !workerId.trim())
      throw new Error("Choose a worker ID");
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
              ...(input.attachments ? { attachments: input.attachments } : {}),
            })
          : input.type === "cancel"
            ? control.cancel({ workerId, reason: input.text })
            : control.complete({ summary: input.text });
    await Effect.runPromise(effect);
    const [command] = await Effect.runPromise(sink.drain);
    if (!command) throw new Error("Command was not accepted");
    return command as unknown as JsonValue;
  }

  async #app(tenantId: string, projectId: string) {
    const key = `${tenantId}:${projectId}`;
    const cached = this.#apps.get(key);
    if (cached) return cached;
    const stored = await (await this.catalog).getProject(tenantId, projectId);
    if (!stored) throw new Error("Unknown project");
    const store = this.storeFor(tenantId);
    const catalog = await this.catalog;
    const driver = (
      role: "coordinator" | "worker",
      agentId: string,
      environmentId?: string,
    ) =>
      makeOmaDriver({
        role,
        agentId,
        ...(environmentId ? { environmentId } : {}),
        projectId,
        tenantId,
        apiKey: () => this.apiKey(tenantId),
        client: this.#client,
        catalog,
        ensureBranch: (input) =>
          ensureGithubBranch({
            ...input,
            token: this.config.githubToken ?? "",
          }),
        ...(stored.config.repositories
          ? { repositories: stored.config.repositories }
          : {}),
        ...(this.config.githubToken
          ? { githubToken: this.config.githubToken }
          : {}),
        beforeTurn: () => this.#assertQuota(tenantId, projectId),
        onUsage: async (usage) => {
          await catalog.recordUsage({
            tenantId,
            projectId: usage.projectId,
            workThreadId: usage.workThreadId,
            turnId: usage.turnId,
            tokens: usage.tokens,
            seconds: 0,
          });
        },
      });
    const app = createOpenMatter({
      store,
      integrations: { project: makeProjectIntegration() },
      agents: {
        coordinator: driver(
          "coordinator",
          stored.config.coordinatorAgent,
          stored.config.coordinatorEnvironment,
        ),
        worker: driver(
          "worker",
          stored.config.workerAgent,
          stored.config.workerEnvironment,
        ),
      },
      eventLeaseMs: 1_000,
    }).loop(
      coordinatorLoop({
        id: `project:${projectId}`,
        continuity: stored.config.continuity,
        agentId: "coordinator",
        workerAgent: "worker",
        sources: [
          "project.message",
          "project.goal.continue",
          ...PROJECT_WORK_EVENT_TYPES.filter(
            (type) => type !== "project.completed",
          ),
        ],
        cancelSources: ["project.worker.cancel.requested"],
        controls: stored.config.controls,
        associate: associateProjectEvent,
        onTurnFinished: ({ context, turn }) => {
          void this.#afterTurn(
            tenantId,
            context.workThreadId,
            context.scopeId,
            turn,
          );
        },
        context: async ({ work, association }) => {
          const workThreadId = projectWorkThreadId(
            projectId,
            stored.config.continuity === "per-run"
              ? association.runId
              : undefined,
            association.thread.kind === "worker"
              ? association.thread.id
              : undefined,
          );
          const goal = await Effect.runPromise(
            store.getThreadGoal(workThreadId),
          );
          return [
            ...(goal
              ? [
                  work.context.value({
                    id: `${workThreadId}:goal`,
                    kind: "thread-goal",
                    value: goal as unknown as JsonValue,
                    provenance: [{ sourceType: "goal", sourceId: goal.id }],
                  }),
                  ...(work.event.type === "project.goal.continue"
                    ? [
                        work.context.value({
                          id: `${work.event.id}:continuation`,
                          kind: "goal-continuation",
                          value: {
                            text: goalContinuationText(goal),
                          } as JsonValue,
                          provenance: [
                            {
                              sourceType: "work-event",
                              sourceId: work.event.id,
                            },
                          ],
                        }),
                      ]
                    : []),
                ]
              : []),
            work.context.value({
              id: `${projectId}:instructions`,
              kind: "project-instructions",
              value: {
                goal: stored.config.description,
                instructions: stored.config.instructions,
              },
              provenance: [{ sourceType: "project", sourceId: projectId }],
            }),
          ];
        },
      }),
    );
    this.#apps.set(key, app);
    return app;
  }

  async #afterTurn(
    tenantId: string,
    workThreadId: string,
    scopeId: string,
    turn: {
      turn: { id: string; createdAt: string; completedAt?: string | undefined };
      outcome: string;
      events: readonly { type: string; data?: unknown }[];
    },
  ) {
    const store = this.storeFor(tenantId);
    const goal = await Effect.runPromise(store.getThreadGoal(workThreadId));
    const tokens = goalTurnTokens(turn as never);
    const seconds = Math.max(
      0,
      Math.floor(
        (Date.parse(turn.turn.completedAt ?? new Date().toISOString()) -
          Date.parse(turn.turn.createdAt)) /
          1000,
      ),
    );
    if (!goal || goal.scopeId !== scopeId) return;
    await Effect.runPromise(
      store.accountThreadGoal(workThreadId, {
        goalId: goal.id,
        turnId: turn.turn.id,
        tokensUsed: tokens,
        timeUsedSeconds: seconds,
      }),
    );
  }

  #validate(config: ProjectWorkConfig) {
    if (
      typeof config.coordinatorAgent !== "string" ||
      typeof config.workerAgent !== "string"
    )
      throw new Error("Invalid agent selection");
    if (!!config.coordinatorAgent.trim() !== !!config.workerAgent.trim())
      throw new Error("Choose both agents, or leave both empty for a draft");
    if (!["per-scope", "per-run"].includes(config.continuity))
      throw new Error("Invalid continuity");
    if (!Array.isArray(config.controls)) throw new Error("Invalid controls");
    validateProjectAttachments(undefined);
  }
}

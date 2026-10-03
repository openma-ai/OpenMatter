import type {
  AgentSession,
  ContextProjection,
  ThreadGoal,
  Turn,
  WorkEvent,
} from "@openmatter/core";
import type { OpenMAEvent } from "@openmatter/agent";
import type { ProjectWorkView } from "./types.js";

export interface ProjectStatusQuery {
  readonly workerId?: string;
  readonly limit?: number;
}

export interface ProjectStatusThread {
  readonly workThreadId: string;
  readonly role: "coordinator" | "worker";
  readonly workerId?: string;
  readonly runId?: string;
  readonly session: Pick<
    AgentSession,
    "id" | "agentId" | "state" | "generation" | "lastUsedAt"
  >;
  readonly turn?: Pick<Turn, "id" | "state" | "createdAt" | "completedAt"> & {
    readonly summary?: string;
    readonly summaryTruncated?: boolean;
    readonly error?: string;
  };
  /** Durable WorkThread outcome; a completed turn is not this status. */
  readonly outcome?: Pick<
    ThreadGoal,
    | "id"
    | "objective"
    | "status"
    | "tokensUsed"
    | "timeUsedSeconds"
    | "tokenBudget"
    | "reason"
    | "revision"
  >;
  readonly remote?: string;
  readonly links?: ProjectExternalLink[];
}

export interface ProjectExternalLink {
  readonly provider: string;
  readonly kind:
    "pull_request" | "merge_request" | "check" | "review" | "commit" | "other";
  readonly externalId?: string;
  readonly title?: string;
  readonly url?: string;
  readonly state?: string;
}

/** Execution facts only. A completed turn does not imply task review or acceptance. */
export interface ProjectStatus {
  readonly project: { readonly id: string; readonly name: string };
  readonly pending: number;
  readonly error: string | null;
  readonly threads: readonly ProjectStatusThread[];
  readonly totalThreads: number;
  readonly truncated: boolean;
}

const TEXT_LIMIT = 2000;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const normalizeRemote = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value
    .trim()
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "");
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return trimmed;
  }
};

const workspaceRemote = (
  workspace: NonNullable<ProjectWorkView["workspaces"]>[number],
): string | undefined => {
  const location = record(workspace.location);
  const spec = record(workspace.spec);
  const repositories = Array.isArray(spec?.repositories)
    ? spec.repositories
    : [];
  const repository = repositories[0] ? record(repositories[0]) : undefined;
  return normalizeRemote(
    location?.remote ?? location?.remoteUrl ?? repository?.url,
  );
};

const nestedRecord = (
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined => {
  const object = record(value);
  if (!object) return undefined;
  for (const key of keys) {
    const nested = record(object[key]);
    if (nested) return nested;
  }
  return undefined;
};

const eventRemote = (event: WorkEvent): string | undefined => {
  const repository = nestedRecord(record(event.payload), [
    "repository",
    "project",
  ]);
  return normalizeRemote(
    repository?.clone_url ??
      repository?.html_url ??
      repository?.web_url ??
      (typeof repository?.path_with_namespace === "string"
        ? `https://github.com/${repository.path_with_namespace}`
        : undefined),
  );
};

const externalLink = (event: WorkEvent): ProjectExternalLink => {
  const type = event.type.toLowerCase();
  const kind = type.includes("merge_request")
    ? "merge_request"
    : type.includes("pull_request")
      ? "pull_request"
      : type.includes("review")
        ? "review"
        : type.includes("workflow") ||
            type.includes("check") ||
            type.includes("pipeline")
          ? "check"
          : type.includes("commit")
            ? "commit"
            : "other";
  const resource = nestedRecord(record(event.payload), [
    "pull_request",
    "merge_request",
    "review",
    "workflow_run",
    "check_run",
    "object_attributes",
  ]);
  const id = resource?.id ?? resource?.number;
  return {
    provider: event.source.provider,
    kind,
    ...(typeof id === "string" || typeof id === "number"
      ? { externalId: String(id) }
      : {}),
    ...(typeof resource?.title === "string" ? { title: resource.title } : {}),
    ...(typeof resource?.html_url === "string"
      ? { url: resource.html_url }
      : {}),
    ...(typeof resource?.state === "string" ? { state: resource.state } : {}),
  };
};

function association(
  context: ContextProjection,
  projectId: string,
): Pick<ProjectStatusThread, "role" | "workerId" | "runId"> | undefined {
  if (context.scopeId !== projectId) return undefined;
  const value = record(
    context.items.find((item) => item.kind === "coordinator-association")
      ?.value,
  );
  if (value?.scopeId !== projectId) return undefined;
  if (value.role !== "coordinator" && value.role !== "worker") return undefined;
  if (value.role === "worker" && typeof value.workerId !== "string")
    return undefined;
  return {
    role: value.role,
    ...(value.role === "worker" ? { workerId: value.workerId as string } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
  };
}

function turnOutput(events: readonly OpenMAEvent[], state: Turn["state"]) {
  const messages = events.filter(
    (event) =>
      event.type === "agent.message" || event.type === "agent.message_chunk",
  );
  const final = messages.filter(
    (event) => record(event.data)?.phase === "final_answer",
  );
  let summary = "";
  let summaryTruncated = false;
  for (const event of final.length ? final : messages) {
    const data = record(event.data);
    const text = typeof data?.text === "string" ? data.text : undefined;
    if (!text) continue;
    const separator = event.type === "agent.message" && summary ? "\n" : "";
    const available = TEXT_LIMIT - summary.length;
    summaryTruncated ||= separator.length + text.length > available;
    summary += (separator + text).slice(0, available);
  }
  let error: string | undefined;
  if (state === "failed" || state === "cancelled") {
    for (const event of events) {
      if (
        ![
          "turn.failed",
          "turn.cancelled",
          "turn.interrupted",
          "session.error",
        ].includes(event.type)
      )
        continue;
      const data = record(event.data);
      const message = data?.message ?? data?.error;
      if (typeof message === "string") error = message.slice(0, TEXT_LIMIT);
    }
  }
  return {
    ...(summary ? { summary } : {}),
    ...(summaryTruncated ? { summaryTruncated: true } : {}),
    ...(error ? { error } : {}),
  };
}

/** Bounded, read-only projection of facts for the host-selected project. */
export function projectStatus(
  view: ProjectWorkView,
  query: ProjectStatusQuery = {},
): ProjectStatus {
  const { facts } = view;
  const contexts = new Map<string, ContextProjection>();
  for (const context of facts.contexts) {
    if (!association(context, view.project.id)) continue;
    const previous = contexts.get(context.workThreadId);
    if (!previous || previous.createdAt <= context.createdAt)
      contexts.set(context.workThreadId, context);
  }
  const sessions = new Map<string, AgentSession>();
  for (const session of facts.sessions) {
    if (session.scopeId !== view.project.id) continue;
    const previous = sessions.get(session.workThreadId);
    if (
      !previous ||
      session.generation > previous.generation ||
      (session.generation === previous.generation &&
        session.lastUsedAt > previous.lastUsedAt)
    ) {
      sessions.set(session.workThreadId, session);
    }
  }
  const remotes = new Map(
    (view.workspaces ?? [])
      .map(
        (workspace) =>
          [workspace.workThreadId, workspaceRemote(workspace)] as const,
      )
      .filter((pair): pair is [string, string] => !!pair[1]),
  );
  const threads: ProjectStatusThread[] = [];
  for (const session of sessions.values()) {
    const context = contexts.get(session.workThreadId);
    const identity = context && association(context, view.project.id);
    if (
      !identity ||
      (query.workerId !== undefined && identity.workerId !== query.workerId)
    )
      continue;
    const turn = facts.turns
      .filter((entry) => entry.sessionId === session.id)
      .reverse()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const events = turn
      ? facts.agentEvents
          .filter(
            (event) =>
              event.session_id === session.id && event.turn_id === turn.id,
          )
          .sort(
            (a, b) =>
              (a.seq ?? 0) - (b.seq ?? 0) ||
              a.occurred_at.localeCompare(b.occurred_at),
          )
      : [];
    const outcome = facts.goals.find(
      (goal) => goal.workThreadId === session.workThreadId,
    );
    const remote = remotes.get(session.workThreadId);
    const links = remote
      ? facts.events
          .filter((event) => eventRemote(event) === remote)
          .map(externalLink)
      : [];
    threads.push({
      workThreadId: session.workThreadId,
      ...identity,
      session: {
        id: session.id,
        agentId: session.agentId,
        state: session.state,
        generation: session.generation,
        lastUsedAt: session.lastUsedAt,
      },
      ...(turn
        ? {
            turn: {
              id: turn.id,
              state: turn.state,
              createdAt: turn.createdAt,
              ...(turn.completedAt ? { completedAt: turn.completedAt } : {}),
              ...turnOutput(events, turn.state),
            },
          }
        : {}),
      ...(outcome
        ? {
            outcome: {
              id: outcome.id,
              objective: outcome.objective,
              status: outcome.status,
              tokensUsed: outcome.tokensUsed,
              timeUsedSeconds: outcome.timeUsedSeconds,
              ...(outcome.tokenBudget === undefined
                ? {}
                : { tokenBudget: outcome.tokenBudget }),
              ...(outcome.reason === undefined
                ? {}
                : { reason: outcome.reason }),
              revision: outcome.revision,
            },
          }
        : {}),
      ...(remote ? { remote } : {}),
      ...(links.length ? { links } : {}),
    });
  }
  threads.sort(
    (a, b) =>
      b.session.lastUsedAt.localeCompare(a.session.lastUsedAt) ||
      a.workThreadId.localeCompare(b.workThreadId),
  );
  const limit = Number.isFinite(query.limit)
    ? Math.max(1, Math.min(30, Math.floor(query.limit!)))
    : 10;
  return {
    project: {
      id: view.project.id,
      name: view.project.name.slice(0, TEXT_LIMIT),
    },
    pending: view.pending,
    error: view.error?.slice(0, TEXT_LIMIT) ?? null,
    threads: threads.slice(0, limit),
    totalThreads: threads.length,
    truncated: threads.length > limit,
  };
}

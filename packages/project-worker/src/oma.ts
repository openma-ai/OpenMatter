import {
  AgentDriverError,
  createOpenMAEvent,
  type AgentDriver,
  type AgentSessionHandle,
  type OpenMAEvent,
} from "@openmatter/agent";
import { Effect, Stream } from "effect";
import type { ProjectCatalog, StoredThread } from "./catalog.js";

export interface OmaClient {
  readonly request: (
    apiKey: string,
    tenantId: string,
    path: string,
    init?: { method?: string; body?: unknown; idempotencyKey?: string },
  ) => Promise<{ status: number; body: unknown }>;
}

export const makeOmaClient = (options: {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
}): OmaClient => ({
  request: async (apiKey, tenantId, path, init = {}) => {
    const response = await (options.fetch ?? fetch)(
      `${options.baseUrl}${path}`,
      {
        method: init.method ?? "GET",
        redirect: "error",
        ...(options.signal ? { signal: options.signal } : {}),
        headers: {
          "x-api-key": apiKey,
          "x-active-tenant": tenantId,
          "content-type": "application/json",
          ...(init.idempotencyKey
            ? { "idempotency-key": init.idempotencyKey }
            : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      },
    );
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  },
});

const errorMessage = (body: unknown, fallback: string) => {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof body.error === "string"
  )
    return body.error;
  return fallback;
};

const driverError = (cause: unknown) =>
  new AgentDriverError({
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

export interface RuntimePlacement {
  readonly placement: "cloud" | "local";
  readonly runtimeId?: string;
  readonly online: boolean;
  readonly status: string;
}

export const readPlacement = async (
  client: OmaClient,
  apiKey: string,
  tenantId: string,
  agentId: string,
): Promise<RuntimePlacement> => {
  const agent = await client.request(
    apiKey,
    tenantId,
    `/v1/agents/${encodeURIComponent(agentId)}`,
  );
  if (agent.status >= 400)
    throw new Error(
      errorMessage(agent.body, `Agent ${agentId} is unavailable`),
    );
  const record = agent.body as {
    _oma?: { runtime_binding?: { runtime_id?: string } };
  };
  const runtimeId = record._oma?.runtime_binding?.runtime_id;
  if (!runtimeId) return { placement: "cloud", online: true, status: "cloud" };
  const runtimes = await client.request(apiKey, tenantId, "/v1/oma/runtimes");
  if (runtimes.status === 401 || runtimes.status === 403)
    return {
      placement: "local",
      runtimeId,
      online: true,
      status: "unverified",
    };
  if (runtimes.status >= 400)
    throw new Error(
      errorMessage(runtimes.body, "Unable to read local runtimes"),
    );
  const list =
    (
      runtimes.body as {
        runtimes?: Array<{
          id: string;
          status?: string;
          last_heartbeat?: number | null;
        }>;
      }
    ).runtimes ?? [];
  const runtime = list.find((item) => item.id === runtimeId);
  const fresh =
    runtime?.last_heartbeat == null ||
    Date.now() / 1000 - Number(runtime.last_heartbeat) < 120;
  const online = runtime?.status === "online" && fresh;
  return {
    placement: "local",
    runtimeId,
    online,
    status: online ? "online" : runtime?.status || "offline",
  };
};

export interface EnsureBranch {
  (input: {
    readonly repository: string;
    readonly base: string;
    readonly branch: string;
  }): Promise<void>;
}

const promptFrom = (items: readonly { kind: string; value: unknown }[]) => {
  const event = items.find((item) => item.kind === "event")?.value as
    { payload?: { text?: string } } | undefined;
  return event?.payload?.text || "Continue the project thread.";
};

export const makeOmaDriver = (options: {
  readonly role: "coordinator" | "worker";
  readonly agentId: string;
  readonly environmentId?: string;
  readonly projectId: string;
  readonly tenantId: string;
  readonly apiKey: () => Promise<string>;
  readonly client: OmaClient;
  readonly catalog: ProjectCatalog;
  readonly ensureBranch?: EnsureBranch;
  readonly repositories?: readonly { url: string; baseRef?: string }[];
  readonly githubToken?: string;
  readonly beforeTurn?: () => Promise<void>;
  readonly onUsage?: (input: {
    readonly turnId: string;
    readonly workThreadId: string;
    readonly projectId: string;
    readonly tokens: number;
  }) => Promise<void>;
}): AgentDriver => ({
  id: `oma:${options.role}:${options.agentId}`,
  capabilities: () =>
    Effect.succeed({
      resume: true,
      cancel: true,
      permissions: false,
      concurrentTurns: false,
    }),
  createSession: (input) =>
    Effect.tryPromise({
      try: async (): Promise<AgentSessionHandle> => {
        if (options.beforeTurn) await options.beforeTurn();
        const apiKey = await options.apiKey();
        const placement = await readPlacement(
          options.client,
          apiKey,
          options.tenantId,
          options.agentId,
        );
        const workThreadId = input.workThreadId ?? input.idempotencyKey;
        if (placement.placement === "local" && !placement.online) {
          await options.catalog.rememberThread(
            options.tenantId,
            options.projectId,
            {
              workThreadId,
              role: options.role,
              sessionId: null,
              creationKey: input.idempotencyKey,
              branch: null,
              placement: "local",
              runtimeId: placement.runtimeId ?? null,
              runtimeStatus: placement.status,
            },
          );
          throw new Error(
            `Local runtime ${placement.runtimeId} is offline. The thread stays on that machine.`,
          );
        }
        let branch: string | null = null;
        const resources: unknown[] = [];
        if (options.role === "worker" && options.repositories?.length) {
          if (!options.githubToken || !options.ensureBranch)
            throw new Error(
              "Set PROJECT_WORKER_GITHUB_TOKEN to create thread branches",
            );
          const repository = options.repositories[0]!;
          branch = `openmatter/${options.projectId}/${workThreadId}`
            .replace(/[^A-Za-z0-9._/-]/g, "-")
            .slice(0, 200);
          await options.ensureBranch({
            repository: repository.url,
            base: repository.baseRef || "HEAD",
            branch,
          });
          resources.push({
            type: "github_repository",
            url: repository.url,
            authorization_token: options.githubToken,
            checkout: { type: "branch", name: branch },
          });
        }
        const existing = await options.catalog.getThread(
          options.tenantId,
          options.projectId,
          workThreadId,
        );
        let sessionId = existing?.sessionId ?? null;
        if (!sessionId) {
          const listed = await options.client.request(
            apiKey,
            options.tenantId,
            `/v1/sessions?q=${encodeURIComponent(input.idempotencyKey)}&limit=20`,
          );
          sessionId =
            (
              (
                listed.body as {
                  data?: Array<{ id: string; title?: string | null }>;
                }
              ).data ?? []
            ).find(
              (session) =>
                session.title === `openmatter:${input.idempotencyKey}`,
            )?.id ?? null;
        }
        if (!sessionId) {
          const created = await options.client.request(
            apiKey,
            options.tenantId,
            "/v1/sessions",
            {
              method: "POST",
              body: {
                agent: options.agentId,
                ...(placement.placement === "cloud" && options.environmentId
                  ? { environment_id: options.environmentId }
                  : {}),
                title: `openmatter:${input.idempotencyKey}`,
                metadata: {
                  projectId: options.projectId,
                  creationKey: input.idempotencyKey,
                  workThreadId,
                  role: options.role,
                },
                ...(resources.length ? { resources } : {}),
              },
            },
          );
          if (created.status >= 400)
            throw new Error(
              errorMessage(created.body, "OpenMA did not create a session"),
            );
          sessionId = String((created.body as { id: string }).id);
          await options.client.request(
            apiKey,
            options.tenantId,
            `/v1/sessions/${sessionId}`,
            {
              method: "POST",
              body: {
                metadata: {
                  projectId: options.projectId,
                  creationKey: input.idempotencyKey,
                  workThreadId,
                  role: options.role,
                },
              },
            },
          );
        }
        const thread: StoredThread = {
          workThreadId,
          role: options.role,
          sessionId,
          creationKey: input.idempotencyKey,
          branch,
          placement: placement.placement,
          runtimeId: placement.runtimeId ?? null,
          runtimeStatus: placement.status,
        };
        await options.catalog.rememberThread(
          options.tenantId,
          options.projectId,
          thread,
        );
        return {
          id: sessionId,
          raw: { sessionId, placement: placement.placement },
        };
      },
      catch: driverError,
    }),
  resumeSession: (handle) => Effect.succeed(handle),
  turn: (input) =>
    Stream.unwrap(
      Effect.tryPromise({
        try: async () => {
          if (options.beforeTurn) await options.beforeTurn();
          const apiKey = await options.apiKey();
          const key = input.context.triggerEventId;
          const posted = await options.client.request(
            apiKey,
            options.tenantId,
            `/v1/sessions/${encodeURIComponent(input.session.id)}/events`,
            {
              method: "POST",
              idempotencyKey: key,
              body: {
                events: [
                  {
                    type: "user.message",
                    id: key,
                    content: [
                      { type: "text", text: promptFrom(input.context.items) },
                    ],
                  },
                ],
              },
            },
          );
          if (posted.status >= 400 && posted.status !== 409)
            throw new Error(
              errorMessage(posted.body, "OpenMA rejected the turn input"),
            );
          const page = await options.client.request(
            apiKey,
            options.tenantId,
            `/v1/sessions/${encodeURIComponent(input.session.id)}/events?order=asc&limit=100&after_seq=0`,
          );
          if (page.status >= 400)
            throw new Error(
              errorMessage(page.body, "OpenMA events are unavailable"),
            );
          const remote =
            (page.body as { data?: Array<Record<string, unknown>> }).data ?? [];
          const text = remote
            .map((event) => {
              if (typeof event.text === "string") return event.text;
              if (!Array.isArray(event.content)) return "";
              return event.content
                .map((block) =>
                  block && typeof block === "object" && "text" in block
                    ? String(block.text)
                    : "",
                )
                .join("");
            })
            .filter(Boolean)
            .join("\n");
          const usage = remote.find((event) => event.type === "usage.updated");
          const usageData =
            usage?.data && typeof usage.data === "object"
              ? (usage.data as Record<string, unknown>)
              : {};
          const tokens =
            Math.max(
              0,
              Number(usageData.input_tokens ?? 0) -
                Number(usageData.cache_read_input_tokens ?? 0),
            ) + Math.max(0, Number(usageData.output_tokens ?? 0));
          if (options.onUsage && Number.isFinite(tokens))
            await options.onUsage({
              turnId: input.turnId,
              workThreadId: input.context.workThreadId,
              projectId: input.context.scopeId,
              tokens: Math.floor(tokens),
            });
          const occurred = new Date().toISOString();
          const emitted: OpenMAEvent[] = [
            createOpenMAEvent({
              event_id: `${input.turnId}:output`,
              session_id: input.sessionId,
              turn_id: input.turnId,
              seq: input.afterSequence + 1,
              type: "agent.message",
              occurred_at: occurred,
              source: { kind: "harness", harness: options.agentId },
              data: { text: text || "completed" },
            }),
            createOpenMAEvent({
              event_id: `${input.turnId}:terminal`,
              session_id: input.sessionId,
              turn_id: input.turnId,
              seq: input.afterSequence + 2,
              type: "turn.completed",
              occurred_at: occurred,
              source: { kind: "harness", harness: options.agentId },
              data: {},
            }),
          ];
          return Stream.fromIterable(
            emitted.filter((event) => (event.seq ?? 0) > input.afterSequence),
          );
        },
        catch: driverError,
      }),
    ),
  respondToPermission: () =>
    Effect.fail(
      new AgentDriverError({
        message:
          "OpenMA session permissions are handled by the session runtime",
      }),
    ),
  cancel: (input) =>
    Effect.tryPromise({
      try: async () => {
        const apiKey = await options.apiKey();
        await options.client.request(
          apiKey,
          options.tenantId,
          `/v1/sessions/${encodeURIComponent(input.session.id)}/cancel`,
          { method: "POST", body: { turnId: input.turnId } },
        );
      },
      catch: driverError,
    }),
  closeSession: () => Effect.void,
});

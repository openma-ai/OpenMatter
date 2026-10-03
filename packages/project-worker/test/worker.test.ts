import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProjectMcpServer } from "@openmatter/project-mcp";
import type { ProjectWorkConfig } from "@openmatter/project-host";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerConfig } from "../src/config.js";
import { ProjectWorkerServer } from "../src/http.js";
import { makeOmaClient } from "../src/oma.js";
import { ensureGithubBranch } from "../src/github.js";
import { startFakeOma, type FakeOma } from "./fake-oma.js";

const directories: string[] = [];
const servers: ProjectWorkerServer[] = [];
const omas: FakeOma[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(omas.splice(0).map((oma) => oma.closes()));
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

const credentialKey = Buffer.from("0123456789abcdef0123456789abcdef");

const configFor = (
  oma: FakeOma,
  dataDir: string,
  extra: Partial<WorkerConfig> = {},
): WorkerConfig => ({
  openmaUrl: oma.url,
  listenHost: "127.0.0.1",
  listenPort: 0,
  store: "sqlite",
  dataDir,
  credentialKey,
  infoTimeoutMs: 10_000,
  ...extra,
});

const projectConfig = (projectId: string): ProjectWorkConfig => ({
  projectId,
  description: "Ship",
  instructions: "Stay on the branch",
  context: "",
  resources: [],
  coordinatorAgent: "coordinator",
  workerAgent: "worker",
  coordinatorEnvironment: "env-coord",
  workerEnvironment: "env-worker",
  continuity: "per-scope",
  controls: ["delegate", "steer", "cancel", "complete"],
});

const start = async (extra: Partial<WorkerConfig> = {}) => {
  const oma = await startFakeOma();
  omas.push(oma);
  const dataDir = await mkdtemp(join(tmpdir(), "project-worker-"));
  directories.push(dataDir);
  const server = new ProjectWorkerServer(
    configFor(oma, dataDir, extra),
    makeOmaClient({ baseUrl: oma.url }),
  );
  servers.push(server);
  const address = await server.listen(0, "127.0.0.1");
  return { oma, server, url: address.url, dataDir };
};

const headers = (tenant: string, key: string) => ({
  authorization: `Bearer ${key}`,
  "x-active-tenant": tenant,
  "content-type": "application/json",
});

const waitFor = async (read: () => Promise<boolean>) => {
  const started = Date.now();
  while (Date.now() - started < 8_000) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("timed out waiting for the project worker");
};

describe("project worker contract", () => {
  it("matches the backchat cloud routes and keeps commands idempotent", async () => {
    const { url, oma } = await start({ workspaceId: "tenant-a" });
    const info = await fetch(`${url}/info`);
    expect(await info.json()).toEqual({
      workspaceId: "tenant-a",
      openmaUrl: oma.url,
    });
    const save = await fetch(
      `${url}/projects/${encodeURIComponent("cloud/project")}`,
      {
        method: "PUT",
        headers: headers("tenant-a", "key-a"),
        body: JSON.stringify({
          project: { id: "cloud/project", name: "Cloud" },
          config: {
            ...projectConfig("cloud/project"),
            execution: {
              kind: "cloud",
              baseUrl: oma.url,
              workspaceId: "tenant-a",
              userId: "u",
            },
          },
        }),
      },
    );
    expect(save.status).toBe(200);
    expect((await save.json()).projectId).toBe("cloud/project");
    const command = {
      projectId: "cloud/project",
      commandId: "business-id",
      type: "message",
      text: "Go",
    };
    const posted = await fetch(
      `${url}/projects/${encodeURIComponent("cloud/project")}/commands`,
      {
        method: "POST",
        headers: headers("tenant-a", "key-a"),
        body: JSON.stringify(command),
      },
    );
    expect(posted.status).toBe(200);
    await fetch(
      `${url}/projects/${encodeURIComponent("cloud/project")}/commands`,
      {
        method: "POST",
        headers: headers("tenant-a", "key-a"),
        body: JSON.stringify(command),
      },
    );
    await waitFor(
      async () => oma.sessions.length === 1 && oma.posts.length === 1,
    );
    const view = await fetch(
      `${url}/projects/${encodeURIComponent("cloud/project")}`,
      {
        headers: headers("tenant-a", "key-a"),
      },
    );
    const body = (await view.json()) as {
      facts: { turns: unknown[] };
      remoteSessions: Array<{ sessionId: string | null }>;
      pending: number;
    };
    expect(body.pending).toBe(0);
    expect(body.facts.turns.length).toBeGreaterThan(0);
    expect(body.remoteSessions[0]?.sessionId).toBe(oma.sessions[0]?.id);
    const goal = await fetch(
      `${url}/projects/${encodeURIComponent("cloud/project")}/goal`,
      {
        method: "POST",
        headers: headers("tenant-a", "key-a"),
        body: JSON.stringify({
          projectId: "cloud/project",
          workThreadId: "project:cloud/project:coordinator",
          objective: "Finish",
        }),
      },
    );
    expect(goal.status).toBe(200);
    expect((await goal.json()).goal.status).toBe("active");
    expect(oma.sessions).toHaveLength(1);
    expect(oma.posts).toHaveLength(1);
  });

  it("isolates tenants and rejects a key for the wrong tenant", async () => {
    const { url } = await start();
    const unauthenticated = await fetch(`${url}/info`);
    expect(await unauthenticated.json()).toEqual({
      multiTenant: true,
      openmaUrl: expect.any(String),
    });
    const scoped = await fetch(`${url}/info`, {
      headers: headers("tenant-a", "key-a"),
    });
    expect(await scoped.json()).toMatchObject({
      multiTenant: true,
      workspaceId: "tenant-a",
    });
    await fetch(`${url}/projects/p`, {
      method: "PUT",
      headers: headers("tenant-a", "key-a"),
      body: JSON.stringify({
        project: { id: "p", name: "A" },
        config: projectConfig("p"),
      }),
    });
    const crossed = await fetch(`${url}/projects/p`, {
      headers: headers("tenant-b", "key-a"),
    });
    expect(crossed.status).toBe(401);
    const missing = await fetch(`${url}/projects/p`, {
      headers: headers("tenant-b", "key-b"),
    });
    expect(missing.status).toBe(404);
    const listed = await fetch(`${url}/projects`, {
      headers: headers("tenant-b", "key-b"),
    });
    expect(await listed.json()).toEqual({ data: [], nextCursor: null });
  });

  it("resumes a project after restart without another session or input", async () => {
    const first = await start({ workspaceId: "tenant-a" });
    await fetch(`${first.url}/projects/p`, {
      method: "PUT",
      headers: headers("tenant-a", "key-a"),
      body: JSON.stringify({
        project: { id: "p", name: "A" },
        config: projectConfig("p"),
      }),
    });
    await fetch(`${first.url}/projects/p/commands`, {
      method: "POST",
      headers: headers("tenant-a", "key-a"),
      body: JSON.stringify({
        projectId: "p",
        commandId: "c1",
        type: "message",
        text: "Go",
      }),
    });
    await waitFor(async () => first.oma.sessions.length === 1);
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    const restarted = new ProjectWorkerServer(
      configFor(first.oma, first.dataDir, { workspaceId: "tenant-a" }),
      makeOmaClient({ baseUrl: first.oma.url }),
    );
    servers.push(restarted);
    const address = await restarted.listen(0, "127.0.0.1");
    await fetch(`${address.url}/projects/p/commands`, {
      method: "POST",
      headers: headers("tenant-a", "key-a"),
      body: JSON.stringify({
        projectId: "p",
        commandId: "c1",
        type: "message",
        text: "Go",
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(first.oma.sessions).toHaveLength(1);
    expect(first.oma.posts).toHaveLength(1);
    const view = await fetch(`${address.url}/projects/p`, {
      headers: headers("tenant-a", "key-a"),
    });
    const body = (await view.json()) as {
      remoteSessions: Array<{ sessionId: string | null }>;
    };
    expect(body.remoteSessions[0]?.sessionId).toBe(first.oma.sessions[0]?.id);
  });

  it("pauses new turns at the usage quota and does not move an offline runtime to the cloud", async () => {
    const quota = await start({ tokenQuota: 3, workspaceId: "tenant-a" });
    await fetch(`${quota.url}/projects/p`, {
      method: "PUT",
      headers: headers("tenant-a", "key-a"),
      body: JSON.stringify({
        project: { id: "p", name: "A" },
        config: projectConfig("p"),
      }),
    });
    await fetch(`${quota.url}/projects/p/commands`, {
      method: "POST",
      headers: headers("tenant-a", "key-a"),
      body: JSON.stringify({
        projectId: "p",
        commandId: "c1",
        type: "message",
        text: "Go",
      }),
    });
    await waitFor(async () => quota.oma.sessions.length === 1);
    await fetch(`${quota.url}/projects/p/commands`, {
      method: "POST",
      headers: headers("tenant-a", "key-a"),
      body: JSON.stringify({
        projectId: "p",
        commandId: "c2",
        type: "message",
        text: "Again",
      }),
    });
    await waitFor(async () => {
      const view = (await (
        await fetch(`${quota.url}/projects/p`, {
          headers: headers("tenant-a", "key-a"),
        })
      ).json()) as { error: string | null; pending: number };
      return view.pending === 0 && /quota/i.test(view.error ?? "");
    });
    expect(quota.oma.sessions).toHaveLength(1);

    const offline = await start({ workspaceId: "tenant-a" });
    offline.oma.agents.worker = { runtimeId: "runtime-1" };
    offline.oma.agents.coordinator = { runtimeId: "runtime-1" };
    offline.oma.runtimes.push({
      id: "runtime-1",
      status: "offline",
      last_heartbeat: 1,
    });
    await fetch(`${offline.url}/projects/p`, {
      method: "PUT",
      headers: headers("tenant-a", "key-a"),
      body: JSON.stringify({
        project: { id: "p", name: "A" },
        config: projectConfig("p"),
      }),
    });
    await fetch(`${offline.url}/projects/p/commands`, {
      method: "POST",
      headers: headers("tenant-a", "key-a"),
      body: JSON.stringify({
        projectId: "p",
        commandId: "c1",
        type: "message",
        text: "Go",
      }),
    });
    await waitFor(async () => {
      const view = (await (
        await fetch(`${offline.url}/projects/p`, {
          headers: headers("tenant-a", "key-a"),
        })
      ).json()) as { error: string | null };
      return /offline/i.test(view.error ?? "");
    });
    expect(offline.oma.sessions).toHaveLength(0);
  });

  it("exposes project goal tools through the MCP binding", async () => {
    const { server } = await start({ workspaceId: "tenant-a" });
    await server.worker.save(
      "tenant-a",
      { id: "p", name: "A" },
      projectConfig("p"),
    );
    const thread = "project:p:coordinator";
    const serverMcp = makeProjectMcpServer({
      goal: {
        get: async () =>
          server.worker
            .setGoal("tenant-a", {
              projectId: "p",
              workThreadId: thread,
              objective: "Keep",
            })
            .then(() =>
              server.worker
                .view("tenant-a", "p")
                .then((view) => view.facts.goals[0] ?? null),
            ),
        create: async (input) => {
          const goal = await server.worker.setGoal("tenant-a", {
            projectId: "p",
            workThreadId: thread,
            objective: input.objective,
            ...(input.tokenBudget === undefined
              ? {}
              : { tokenBudget: input.tokenBudget }),
          });
          if (!goal) throw new Error("Goal was not created");
          return goal;
        },
        update: async () => {
          throw new Error("not used");
        },
      },
    });
    const tools = (
      serverMcp as unknown as {
        _registeredTools: Record<
          string,
          {
            handler: (input: object) => Promise<{
              structuredContent: { goal: { objective: string } };
            }>;
          }
        >;
      }
    )._registeredTools;
    const created = await tools.create_goal!.handler({
      objective: "Ship the branch",
    });
    expect(created.structuredContent.goal.objective).toBe("Ship the branch");
  });
});

describe("mysql project worker", () => {
  it("stores a cloud project in MySQL when PROJECT_WORKER_MYSQL_URL is set", async (ctx) => {
    const mysqlUrl = process.env.PROJECT_WORKER_MYSQL_URL;
    if (!mysqlUrl) {
      ctx.skip("MySQL tests need PROJECT_WORKER_MYSQL_URL");
      return;
    }
    const projectId = `mysql-${Date.now()}`;
    const { url, oma } = await start({
      store: "mysql",
      mysqlUrl,
      workspaceId: "tenant-a",
    });
    const saved = await fetch(`${url}/projects/${projectId}`, {
      method: "PUT",
      headers: headers("tenant-a", "key-a"),
      body: JSON.stringify({
        project: { id: projectId, name: "MySQL" },
        config: projectConfig(projectId),
      }),
    });
    expect(saved.status).toBe(200);
    const posted = await fetch(`${url}/projects/${projectId}/commands`, {
      method: "POST",
      headers: headers("tenant-a", "key-a"),
      body: JSON.stringify({
        projectId,
        commandId: "c1",
        type: "message",
        text: "Go",
      }),
    });
    expect(posted.status).toBe(200);
    await waitFor(async () => {
      if (oma.sessions.length === 1) return true;
      const current = (await (
        await fetch(`${url}/projects/${projectId}`, {
          headers: headers("tenant-a", "key-a"),
        })
      ).json()) as { error: string | null; pending: number };
      if (current.error) throw new Error(current.error);
      return false;
    });
    const view = (await (
      await fetch(`${url}/projects/${projectId}`, {
        headers: headers("tenant-a", "key-a"),
      })
    ).json()) as { remoteSessions: Array<{ sessionId: string | null }> };
    expect(view.remoteSessions[0]?.sessionId).toBe(oma.sessions[0]?.id);
  }, 20_000);
});

describe("github thread branches", () => {
  it("creates a branch from the base ref and treats an existing ref as success", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/git/ref/heads/main"))
        return new Response(JSON.stringify({ object: { sha: "abc" } }), {
          status: 200,
        });
      return new Response("exists", { status: 422 });
    };
    await ensureGithubBranch({
      token: "github-token",
      repository: "https://github.com/openma/example",
      base: "main",
      branch: "openmatter/project/thread",
      fetch: fetchImpl,
      apiBase: "https://github.test",
    });
    expect(calls[1]).toContain("/git/refs");
  });
});

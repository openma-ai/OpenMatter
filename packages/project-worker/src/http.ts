import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type {
  ProjectWorkCommand,
  ProjectWorkConfig,
} from "@openmatter/project-host";
import type { ProjectGoalInput } from "@openmatter/project-host";
import type { WorkerConfig } from "./config.js";
import { ProjectWorker } from "./coordinator.js";
import type { OmaClient } from "./oma.js";

interface Auth {
  readonly tenantId: string;
  readonly apiKey: string;
}

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_000_000) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
};

const send = (res: ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
};

const fail = (res: ServerResponse, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = /unknown project/i.test(message)
    ? 404
    : /unauthorized|credential|api key|tenant/i.test(message)
      ? 401
      : /quota|offline|pending|reused|both agents/i.test(message)
        ? 409
        : 400;
  send(res, status, { error: message });
};

export class ProjectWorkerServer {
  readonly worker: ProjectWorker;
  #server?: ReturnType<typeof createServer>;
  readonly #authCache = new Map<string, number>();

  constructor(
    readonly config: WorkerConfig,
    client?: OmaClient,
  ) {
    this.worker = new ProjectWorker(config, client);
  }

  async listen(port = this.config.listenPort, host = this.config.listenHost) {
    this.worker.start();
    this.#server = createServer((req, res) => {
      void this.#handle(req, res);
    });
    await new Promise<void>((resolve) =>
      this.#server!.listen(port, host, resolve),
    );
    const address = this.#server.address();
    const bound = typeof address === "object" && address ? address.port : port;
    return {
      port: bound,
      url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${bound}`,
    };
  }

  async close() {
    await this.worker.close();
    if (!this.#server) return;
    await new Promise<void>((resolve, reject) =>
      this.#server?.close((error) => (error ? reject(error) : resolve())),
    );
  }

  async #handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/info") {
        send(res, 200, await this.#info(req));
        return;
      }
      const auth = await this.#authorize(req);
      if (req.method === "GET" && url.pathname === "/projects") {
        const cursor = Number(url.searchParams.get("cursor") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "20");
        send(res, 200, await this.worker.list(auth.tenantId, cursor, limit));
        return;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "projects" || !parts[1]) {
        send(res, 404, { error: "Unknown project route" });
        return;
      }
      const id = decodeURIComponent(parts[1]);
      const action = parts[2];
      if (req.method === "GET" && !action) {
        send(res, 200, await this.worker.view(auth.tenantId, id));
        return;
      }
      if (req.method === "PUT" && !action) {
        const body = (await readBody(req)) as {
          project: { id: string; name: string };
          config: ProjectWorkConfig;
        };
        if (body.config.projectId !== id)
          throw new Error("Project id does not match");
        const execution = (
          body.config as { execution?: { workspaceId?: string } }
        ).execution;
        if (execution?.workspaceId && execution.workspaceId !== auth.tenantId)
          throw new Error("Project tenant does not match x-active-tenant");
        await this.worker.rememberKey(auth.tenantId, auth.apiKey);
        send(
          res,
          200,
          await this.worker.save(auth.tenantId, body.project, body.config),
        );
        return;
      }
      if (req.method === "DELETE" && !action) {
        await this.worker.remove(auth.tenantId, id);
        send(res, 200, {});
        return;
      }
      if (req.method === "POST" && action === "commands") {
        const command = (await readBody(req)) as ProjectWorkCommand;
        if (command.projectId !== id)
          throw new Error("Project id does not match");
        await this.worker.rememberKey(auth.tenantId, auth.apiKey);
        await this.worker.submit(auth.tenantId, command);
        send(res, 200, { accepted: true });
        return;
      }
      if (req.method === "POST" && action === "goal") {
        const goal = (await readBody(req)) as ProjectGoalInput;
        if (goal.projectId !== id) throw new Error("Project id does not match");
        send(res, 200, {
          goal: await this.worker.setGoal(auth.tenantId, goal),
        });
        return;
      }
      send(res, 404, { error: "Unknown project route" });
    } catch (error) {
      if (!res.headersSent) fail(res, error);
    }
  }

  async #info(req: IncomingMessage) {
    const tenant = header(req, "x-active-tenant");
    const openmaUrl = this.config.openmaUrl;
    if (!tenant) {
      if (this.config.workspaceId)
        return { workspaceId: this.config.workspaceId, openmaUrl };
      return { multiTenant: true, openmaUrl };
    }
    await this.#authorize(req);
    if (this.config.workspaceId && tenant !== this.config.workspaceId)
      throw new Error(
        "Projects worker belongs to a different OpenMA workspace",
      );
    return {
      multiTenant: !this.config.workspaceId,
      workspaceId: tenant,
      openmaUrl,
    };
  }

  async #authorize(req: IncomingMessage): Promise<Auth> {
    const tenantId = header(req, "x-active-tenant");
    const authorization = header(req, "authorization");
    if (!tenantId || !authorization?.toLowerCase().startsWith("bearer "))
      throw new Error("Unauthorized project worker request");
    if (this.config.workspaceId && tenantId !== this.config.workspaceId)
      throw new Error(
        "Projects worker belongs to a different OpenMA workspace",
      );
    const apiKey = authorization.slice("bearer ".length).trim();
    const cacheKey = `${tenantId}:${apiKey}`;
    if ((this.#authCache.get(cacheKey) ?? 0) > Date.now())
      return { tenantId, apiKey };
    const checked = await this.worker.verifyTenant(apiKey, tenantId);
    if (checked.status === 401 || checked.status === 403)
      throw new Error("OpenMA rejected this api key for the active tenant");
    if (checked.status >= 400) throw new Error("OpenMA tenant check failed");
    this.#authCache.set(cacheKey, Date.now() + 60_000);
    return { tenantId, apiKey };
  }
}

const header = (req: IncomingMessage, name: string) => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

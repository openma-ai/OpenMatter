import { createServer, type Server } from "node:http";

export interface FakeOma {
  readonly url: string;
  readonly sessions: Array<{
    id: string;
    title: string;
    tenantId: string;
    agent: string;
  }>;
  readonly posts: Array<{ sessionId: string; key: string | undefined }>;
  readonly closes: () => Promise<void>;
  agents: Record<string, { runtimeId?: string }>;
  runtimes: Array<{
    id: string;
    status: string;
    last_heartbeat: number | null;
  }>;
  keys: Record<string, string>;
}

export const startFakeOma = async (): Promise<FakeOma> => {
  const sessions: FakeOma["sessions"] = [];
  const posts: FakeOma["posts"] = [];
  const seen = new Set<string>();
  const state: Pick<FakeOma, "agents" | "runtimes" | "keys"> = {
    agents: { coordinator: {}, worker: {} },
    runtimes: [],
    keys: { "key-a": "tenant-a", "key-b": "tenant-b" },
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const tenant = String(req.headers["x-active-tenant"] ?? "");
    const key = String(req.headers["x-api-key"] ?? "");
    const send = (status: number, body: unknown) => {
      res
        .writeHead(status, { "content-type": "application/json" })
        .end(JSON.stringify(body));
    };
    if (state.keys[key] !== tenant) {
      send(401, { error: "invalid api key" });
      return;
    }
    if (url.pathname === "/v1/oma/me") {
      send(200, { tenant_id: tenant });
      return;
    }
    if (url.pathname.startsWith("/v1/agents/")) {
      const id = decodeURIComponent(url.pathname.slice("/v1/agents/".length));
      const agent = state.agents[id];
      if (!agent) {
        send(404, { error: "Agent not found" });
        return;
      }
      send(200, {
        id,
        ...(agent.runtimeId
          ? { _oma: { runtime_binding: { runtime_id: agent.runtimeId } } }
          : {}),
      });
      return;
    }
    if (url.pathname === "/v1/oma/runtimes") {
      send(200, { runtimes: state.runtimes });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/sessions") {
      const query = url.searchParams.get("q") ?? "";
      send(200, {
        data: sessions.filter(
          (session) =>
            session.tenantId === tenant && session.title.includes(query),
        ),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/sessions") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as { title: string; agent: string };
      const existing = sessions.find(
        (session) =>
          session.title === body.title && session.tenantId === tenant,
      );
      if (existing) {
        send(200, { id: existing.id });
        return;
      }
      const created = {
        id: `sess-${sessions.length + 1}`,
        title: body.title,
        tenantId: tenant,
        agent: body.agent,
      };
      sessions.push(created);
      send(201, { id: created.id });
      return;
    }
    const events = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
    if (events && req.method === "POST") {
      const keyHeader = req.headers["idempotency-key"];
      const idempotency = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
      const identity = `${events[1]}:${idempotency ?? ""}`;
      if (!seen.has(identity)) {
        seen.add(identity);
        posts.push({
          sessionId: decodeURIComponent(events[1]!),
          key: idempotency,
        });
      }
      send(202, {});
      return;
    }
    if (events && req.method === "GET") {
      send(200, {
        data: [
          {
            type: "agent.message",
            content: [{ type: "text", text: "shipped" }],
          },
          {
            type: "usage.updated",
            data: { input_tokens: 1, output_tokens: 2 },
          },
          { type: "session.status_idle" },
        ],
      });
      return;
    }
    if (req.method === "POST" && /^\/v1\/sessions\/[^/]+$/.test(url.pathname)) {
      send(200, {});
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/cancel")) {
      send(200, {});
      return;
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    sessions,
    posts,
    agents: state.agents,
    runtimes: state.runtimes,
    keys: state.keys,
    closes: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

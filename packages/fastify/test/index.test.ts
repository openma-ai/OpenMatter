import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { openMatter } from "../src/index.js";

const listen = async (server: FastifyInstance) => {
  const url = await server.listen({ host: "127.0.0.1", port: 0 });
  return { url, close: () => server.close() };
};

describe("OpenMatter Fastify component", () => {
  it("preserves the raw request bytes passed to an endpoint", async () => {
    const server = Fastify();
    await server.register(
      openMatter({
        endpoints: [
          {
            method: "POST",
            path: "/hooks/native",
            handle: async (request: Request) =>
              Response.json({
                bytes: [...new Uint8Array(await request.arrayBuffer())],
              }),
          },
        ],
      }),
    );
    const { url, close } = await listen(server);

    try {
      const response = await fetch(`${url}/hooks/native`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Uint8Array.from([0, 127, 128, 255]),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ bytes: [0, 127, 128, 255] });
    } finally {
      await close();
    }
  });

  it("returns the endpoint response without flattening its status, headers, or body", async () => {
    const server = Fastify();
    await server.register(
      openMatter({
        endpoints: [
          {
            method: "POST",
            path: "/hooks/result",
            handle: async () =>
              new Response(Uint8Array.from([240, 159, 140, 177]), {
                status: 202,
                headers: {
                  "content-type": "application/octet-stream",
                  "x-openmatter-result": "accepted",
                },
              }),
          },
        ],
      }),
    );
    const { url, close } = await listen(server);

    try {
      const response = await fetch(`${url}/hooks/result`, {
        method: "POST",
        body: "trigger",
      });

      expect(response.status).toBe(202);
      expect(response.headers.get("x-openmatter-result")).toBe("accepted");
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
        240, 159, 140, 177,
      ]);
    } finally {
      await close();
    }
  });
});

import { describe, expect, it } from "vitest";
import { openMatter } from "../src/index.js";

describe("OpenMatter Hono component", () => {
  it("passes Hono's untouched Web Request to an endpoint", async () => {
    const app = openMatter({
      endpoints: [
        {
          method: "POST",
          path: "/hooks/native",
          handle: async (request: Request) =>
            Response.json({
              url: request.url,
              bytes: [...new Uint8Array(await request.arrayBuffer())],
            }),
        },
      ],
    });
    const request = new Request(
      "https://agent.example.com/hooks/native?delivery=42",
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Uint8Array.from([0, 127, 128, 255]),
      },
    );

    const response = await app.request(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "https://agent.example.com/hooks/native?delivery=42",
      bytes: [0, 127, 128, 255],
    });
  });

  it("returns the endpoint Response unchanged", async () => {
    const expected = new Response("queued", {
      status: 202,
      headers: { "x-openmatter-result": "accepted" },
    });
    const app = openMatter({
      endpoints: [
        {
          method: "POST",
          path: "/hooks/result",
          handle: async () => expected,
        },
      ],
    });

    const response = await app.request(
      new Request("https://agent.example.com/hooks/result", {
        method: "POST",
      }),
    );

    expect(response).toBe(expected);
    expect(response.status).toBe(202);
    expect(response.headers.get("x-openmatter-result")).toBe("accepted");
    expect(await response.text()).toBe("queued");
  });
});

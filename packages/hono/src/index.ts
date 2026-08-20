import type { HttpEndpoint } from "@openmatter/http";
import { Hono } from "hono";

export interface OpenMatterHonoOptions {
  readonly endpoints: readonly HttpEndpoint[];
}

/** Build a mountable Hono application for OpenMatter HTTP endpoints. */
export const openMatter = (options: OpenMatterHonoOptions): Hono => {
  const router = new Hono();
  for (const endpoint of options.endpoints) {
    router.on(endpoint.method, endpoint.path, (context) =>
      endpoint.handle(context.req.raw),
    );
  }
  return router;
};

export type { HttpEndpoint, HttpMethod } from "@openmatter/http";

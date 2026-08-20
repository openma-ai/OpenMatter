import type { HttpEndpoint } from "@openmatter/http";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

export interface OpenMatterFastifyOptions {
  readonly endpoints: readonly HttpEndpoint[];
}

const headersFrom = (
  input: Readonly<Record<string, string | readonly string[] | undefined>>,
): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === "string") headers.append(name, value);
    else if (value !== undefined) {
      for (const item of value) headers.append(name, item);
    }
  }
  return headers;
};

const webRequestFrom = (request: FastifyRequest): Request => {
  const headers = headersFrom(request.headers);
  const authority = headers.get("host") ?? "localhost";
  const url = new URL(
    request.raw.url ?? request.url,
    `${request.protocol}://${authority}`,
  );
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : request.body instanceof Uint8Array
        ? Uint8Array.from(request.body)
        : undefined;

  return new Request(url, {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
};

const sendResponse = async (response: Response, reply: FastifyReply) => {
  reply.code(response.status);
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") reply.header(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) reply.header("set-cookie", cookies);
  return reply.send(Buffer.from(await response.arrayBuffer()));
};

/** Build an encapsulated Fastify plugin that mounts OpenMatter endpoints. */
export const openMatter =
  (options: OpenMatterFastifyOptions): FastifyPluginAsync =>
  async (fastify) => {
    // Provider signature verification must see exact wire bytes, never a body
    // reconstructed from Fastify's JSON or form parsing.
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser(
      "*",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    for (const endpoint of options.endpoints) {
      fastify.route({
        method: endpoint.method,
        url: endpoint.path,
        handler: async (request, reply) =>
          sendResponse(await endpoint.handle(webRequestFrom(request)), reply),
      });
    }
  };

export type { HttpEndpoint, HttpMethod } from "@openmatter/http";

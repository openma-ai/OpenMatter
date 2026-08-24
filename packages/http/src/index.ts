/** HTTP methods that may carry provider webhooks or application callbacks. */
export type HttpMethod =
  "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";

/**
 * A provider-owned HTTP boundary. Integrations may verify signatures, decode
 * native payloads, enqueue work, and choose the protocol response here.
 * Framework adapters only mount this endpoint and preserve Web API semantics.
 */
export interface HttpEndpoint {
  readonly method: HttpMethod;
  readonly path: string;
  readonly handle: (request: Request) => Response | Promise<Response>;
}

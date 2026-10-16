import { JsonValueSchema, type JsonValue } from "@openma/matter";
import type { HttpEndpoint } from "@openma/matter/http";
import { Data, Effect, Schema } from "effect";
import { isRecord, nonEmptyString } from "./shared.js";

export class FeishuHttpIngressError extends Data.TaggedError(
  "FeishuHttpIngressError",
)<{
  readonly message: string;
  readonly status: 400 | 401;
  readonly cause?: unknown;
}> {}

export class FeishuHttpSubmissionError extends Data.TaggedError(
  "FeishuHttpSubmissionError",
)<{
  readonly message: string;
  readonly status: 503;
  readonly cause?: unknown;
}> {}

/**
 * One verified Feishu event, ready for `integration.ingest`. The webhook
 * endpoint and the long-connection source both produce this shape, so
 * `ingest` never knows which transport delivered it.
 */
export interface FeishuEventInput {
  readonly kind: "feishu.event";
  /**
   * Who received the event, chosen by the host (for example a Bond id). It
   * becomes the Event source authority and selects credentials for replies.
   */
  readonly authority: string;
  readonly transport: "webhook" | "long_connection";
  /**
   * The bot's `open_id` in this app, from `inspectFeishuApp`. Without it a
   * group message is never classified as a mention.
   */
  readonly botOpenId?: string;
  /** The decrypted v2 envelope `{ schema, header, event }`. */
  readonly envelope: JsonValue;
}

/** A URL verification request, answered by echoing the challenge. */
export interface FeishuChallenge {
  readonly kind: "feishu.challenge";
  readonly challenge: string;
}

export interface FeishuWebhookOptions {
  readonly authority: string;
  /** The app ID; `header.app_id` must match it. */
  readonly appId: string;
  /** Required: webhook ingress accepts encrypted, signed requests only. */
  readonly encryptKey: string;
  /** When set, `header.token` (or the challenge `token`) must match it. */
  readonly verificationToken?: string;
  readonly botOpenId?: string;
  /** Accepted clock skew of `X-Lark-Request-Timestamp`. Default 300 s. */
  readonly toleranceSeconds?: number;
  /** For tests. */
  readonly nowMs?: () => number;
}

export interface FeishuHttpEndpointOptions extends FeishuWebhookOptions {
  readonly path?: string;
  /** Stores the event durably (for example in a DurableInbox) before the 200. */
  readonly submit: (input: FeishuEventInput) => Promise<unknown>;
  /**
   * The synchronous answer to a `card.action.trigger` callback, such as a
   * toast. A Loop cannot answer within Feishu's 3 s budget; it updates the
   * card later through an Effect. Default `{}`.
   */
  readonly cardActionResponse?: JsonValue;
}

const encoder = new TextEncoder();

const sha256 = async (
  value: string | Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      typeof value === "string" ? encoder.encode(value) : value,
    ),
  );

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Constant time, and hashed first so neither length leaks. */
const sameSecret = async (expected: string, received: string) => {
  if (expected.length === 0) return false;
  const [a, b] = await Promise.all([sha256(expected), sha256(received)]);
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) difference |= a[i]! ^ b[i]!;
  return difference === 0;
};

/**
 * `X-Lark-Signature` is `hex(sha256(timestamp + nonce + encryptKey + body))`
 * over the raw request body.
 */
export const feishuSignature = async (input: {
  readonly timestamp: string;
  readonly nonce: string;
  readonly encryptKey: string;
  readonly body: string;
}): Promise<string> =>
  hex(
    await sha256(input.timestamp + input.nonce + input.encryptKey + input.body),
  );

const base64Bytes = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

/**
 * Decrypts an `encrypt` field: AES-256-CBC with key `sha256(encryptKey)`;
 * the first 16 bytes of the base64 payload are the IV. PKCS#7 padding.
 */
export const decryptFeishuPayload = async (
  encrypted: string,
  encryptKey: string,
): Promise<string> => {
  const bytes = base64Bytes(encrypted);
  if (bytes.length <= 16 || (bytes.length - 16) % 16 !== 0) {
    throw new Error("Encrypted payload has an invalid length");
  }
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    await sha256(encryptKey),
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );
  const plain = await globalThis.crypto.subtle.decrypt(
    { name: "AES-CBC", iv: bytes.slice(0, 16) },
    key,
    bytes.slice(16),
  );
  return new TextDecoder().decode(plain);
};

const header = (request: Request, name: string): string | undefined => {
  const value = request.headers.get(name);
  return value === null || value.length === 0 ? undefined : value;
};

const ingressError = (message: string, status: 400 | 401, cause?: unknown) =>
  new FeishuHttpIngressError({
    message,
    status,
    ...(cause === undefined ? {} : { cause }),
  });

/**
 * Verifies and decodes one Feishu webhook request.
 *
 * The body must be `{ "encrypt": … }`; plaintext bodies are refused. A URL
 * verification request is not signed by Feishu, so it is accepted when it
 * decrypts with the encrypt key and its token matches; the answer only
 * echoes the challenge. Every other request must carry a valid
 * `X-Lark-Signature` within the timestamp tolerance, decrypt to a v2
 * envelope, and name this app in `header.app_id`.
 */
export const decodeFeishuHttpRequest = (
  request: Request,
  options: FeishuWebhookOptions,
): Effect.Effect<FeishuEventInput | FeishuChallenge, FeishuHttpIngressError> =>
  Effect.gen(function* () {
    if (options.encryptKey.length === 0) {
      return yield* ingressError("Feishu webhook needs an encrypt key", 401);
    }
    const rawBody = yield* Effect.tryPromise({
      try: () => request.text(),
      catch: (cause) =>
        ingressError("Unable to read Feishu request body", 400, cause),
    });
    const outer = yield* Effect.try({
      try: () => JSON.parse(rawBody) as unknown,
      catch: (cause) =>
        ingressError("Feishu request body is malformed", 400, cause),
    });
    if (!isRecord(outer) || !nonEmptyString(outer.encrypt)) {
      return yield* ingressError("Feishu request body must be encrypted", 401);
    }
    const decrypted = yield* Effect.tryPromise({
      try: () =>
        decryptFeishuPayload(outer.encrypt as string, options.encryptKey),
      catch: (cause) =>
        ingressError("Unable to decrypt Feishu request", 401, cause),
    });
    const payload = yield* Effect.try({
      try: () => JSON.parse(decrypted) as unknown,
      catch: (cause) =>
        ingressError("Decrypted Feishu payload is malformed", 400, cause),
    });
    if (!isRecord(payload)) {
      return yield* ingressError("Feishu payload must be an object", 400);
    }

    const token = options.verificationToken;
    if (payload.type === "url_verification") {
      if (
        token !== undefined &&
        !(yield* Effect.promise(() =>
          sameSecret(
            token,
            typeof payload.token === "string" ? payload.token : "",
          ),
        ))
      ) {
        return yield* ingressError("Feishu verification token is invalid", 401);
      }
      if (!nonEmptyString(payload.challenge)) {
        return yield* ingressError("Feishu challenge is missing", 400);
      }
      return { kind: "feishu.challenge", challenge: payload.challenge };
    }

    const timestamp = header(request, "x-lark-request-timestamp");
    const nonce = header(request, "x-lark-request-nonce");
    const signature = header(request, "x-lark-signature");
    if (
      timestamp === undefined ||
      nonce === undefined ||
      signature === undefined
    ) {
      return yield* ingressError("Feishu signature headers are required", 401);
    }
    const seconds = /^\d+$/.test(timestamp) ? Number(timestamp) : NaN;
    const now = (options.nowMs ?? Date.now)() / 1000;
    if (
      !Number.isFinite(seconds) ||
      Math.abs(now - seconds) > (options.toleranceSeconds ?? 300)
    ) {
      return yield* ingressError("Feishu request timestamp is stale", 401);
    }
    const expected = yield* Effect.promise(() =>
      feishuSignature({
        timestamp,
        nonce,
        encryptKey: options.encryptKey,
        body: rawBody,
      }),
    );
    if (
      !(yield* Effect.promise(() =>
        sameSecret(expected, signature.toLowerCase()),
      ))
    ) {
      return yield* ingressError("Feishu signature is invalid", 401);
    }

    const head = payload.header;
    if (payload.schema !== "2.0" || !isRecord(head)) {
      return yield* ingressError("Feishu event must use the 2.0 schema", 400);
    }
    if (head.app_id !== options.appId) {
      return yield* ingressError("Feishu event is for another app", 401);
    }
    if (
      token !== undefined &&
      !(yield* Effect.promise(() =>
        sameSecret(token, typeof head.token === "string" ? head.token : ""),
      ))
    ) {
      return yield* ingressError("Feishu verification token is invalid", 401);
    }
    if (!nonEmptyString(head.event_id) || !nonEmptyString(head.event_type)) {
      return yield* ingressError("Feishu event id and type are required", 400);
    }
    if (!Schema.is(JsonValueSchema)(payload)) {
      return yield* ingressError("Feishu event must be portable JSON", 400);
    }
    return {
      kind: "feishu.event",
      authority: options.authority,
      transport: "webhook",
      ...(options.botOpenId === undefined
        ? {}
        : { botOpenId: options.botOpenId }),
      envelope: payload as JsonValue,
    };
  });

const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const eventType = (input: FeishuEventInput): string | undefined => {
  const envelope = input.envelope;
  return isRecord(envelope) &&
    isRecord(envelope.header) &&
    typeof envelope.header.event_type === "string"
    ? envelope.header.event_type
    : undefined;
};

/**
 * A webhook endpoint for one Feishu app. Answers a URL verification with the
 * challenge, and an event with HTTP 200 only after `submit` resolved, so a
 * failed write makes Feishu retry (503). Hosts that serve many apps from one
 * route call `decodeFeishuHttpRequest` with the options they look up.
 */
export const makeFeishuHttpEndpoint = (
  options: FeishuHttpEndpointOptions,
): HttpEndpoint => ({
  method: "POST",
  path: options.path ?? "/feishu/events",
  handle: (request) =>
    Effect.runPromise(
      decodeFeishuHttpRequest(request, options).pipe(
        Effect.flatMap((decoded) =>
          decoded.kind === "feishu.challenge"
            ? Effect.succeed(
                jsonResponse({ challenge: decoded.challenge }, 200),
              )
            : Effect.tryPromise({
                try: () => options.submit(decoded),
                catch: (cause) =>
                  new FeishuHttpSubmissionError({
                    message: "Unable to submit Feishu work",
                    status: 503,
                    cause,
                  }),
              }).pipe(
                Effect.as(
                  jsonResponse(
                    eventType(decoded) === "card.action.trigger"
                      ? (options.cardActionResponse ?? {})
                      : {},
                    200,
                  ),
                ),
              ),
        ),
        Effect.catchAll((error) =>
          Effect.succeed(
            jsonResponse({ ok: false, error: error.message }, error.status),
          ),
        ),
      ),
    ),
});

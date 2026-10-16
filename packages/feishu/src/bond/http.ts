import { ProviderError } from "@openma/matter/bond";
import { Effect } from "effect";

export type Fetch = typeof globalThis.fetch;

export type FeishuBrand = "feishu" | "lark";

/** The two origins a Feishu or Lark app talks to. */
export interface FeishuEndpoints {
  readonly brand: FeishuBrand;
  /** Open Platform API origin, such as `https://open.feishu.cn`. */
  readonly open: string;
  /** User authorization origin, such as `https://accounts.feishu.cn`. */
  readonly accounts: string;
}

const HOSTS: Readonly<Record<string, FeishuBrand>> = {
  "open.feishu.cn": "feishu",
  "accounts.feishu.cn": "feishu",
  "open.larksuite.com": "lark",
  "accounts.larksuite.com": "lark",
};

const DOMAIN: Readonly<Record<FeishuBrand, string>> = {
  feishu: "feishu.cn",
  lark: "larksuite.com",
};

/**
 * Resolves the brand from a ProviderApp `baseUrl`. Accepts the open or the
 * accounts origin of Feishu or Lark over https, without a path, credentials,
 * query, or fragment. Any other host is an error: tokens are only ever sent
 * to the fixed Feishu and Lark origins.
 */
export const feishuEndpoints = (baseUrl: string): FeishuEndpoints => {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") {
    throw new Error("Feishu base URL must use https");
  }
  if (url.username || url.password || url.search || url.hash || url.port) {
    throw new Error(
      "Feishu base URL must not carry credentials, a port, query, or fragment",
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Feishu base URL must be an origin without a path");
  }
  const brand = HOSTS[url.hostname.toLowerCase()];
  if (brand === undefined) {
    throw new Error(
      "Feishu base URL must be open.feishu.cn, accounts.feishu.cn, open.larksuite.com, or accounts.larksuite.com",
    );
  }
  return {
    brand,
    open: `https://open.${DOMAIN[brand]}`,
    accounts: `https://accounts.${DOMAIN[brand]}`,
  };
};

/** `feishuEndpoints` as an Effect; an unusable base URL is a configuration problem. */
export const endpoints = (
  baseUrl: string,
): Effect.Effect<FeishuEndpoints, ProviderError> =>
  Effect.try({
    try: () => feishuEndpoints(baseUrl),
    catch: (cause) =>
      new ProviderError({
        message: cause instanceof Error ? cause.message : "Invalid base URL",
        rejected: false,
        cause,
      }),
  });

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Rate limits and transient server errors. Callers may retry these. */
const RETRYABLE_CODES = new Set([99991400, 20050, 20072]);

export const isRetryableFeishuFailure = (
  status: number,
  code: number | undefined,
): boolean =>
  status === 429 ||
  status >= 500 ||
  (code !== undefined && RETRYABLE_CODES.has(code));

export interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

/** One JSON request. Never follows redirects: a redirect is an error. */
export const requestJson = (
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
): Effect.Effect<JsonResponse, ProviderError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetchImpl(url, { ...init, redirect: "manual" });
      const text = await response.text();
      let body: unknown = undefined;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
      }
      return { status: response.status, body };
    },
    catch: (cause) =>
      new ProviderError({
        message: `Feishu request failed: ${new URL(url).pathname}`,
        rejected: false,
        cause,
      }),
  });

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The Feishu business code of a response body, when present. */
export const feishuCode = (body: unknown): number | undefined =>
  isRecord(body) && typeof body.code === "number" ? body.code : undefined;

/** HTTP 2xx and a Feishu `code` of 0 or absent. */
export const succeeded = (response: JsonResponse): boolean =>
  response.status >= 200 &&
  response.status < 300 &&
  (feishuCode(response.body) ?? 0) === 0;

/**
 * Maps a failed Feishu response to a ProviderError without echoing the body
 * (it may repeat request fields). `rejected` is decided by the caller: only
 * an answer meaning the grant itself is gone may end a link. The cause
 * carries the Feishu code and whether it is retryable.
 */
export const feishuError = (
  what: string,
  response: JsonResponse,
  rejected = false,
): ProviderError => {
  const code = feishuCode(response.body);
  const error =
    isRecord(response.body) && typeof response.body.error === "string"
      ? response.body.error
      : undefined;
  const detail = [
    code === undefined ? undefined : `code ${code}`,
    error,
  ].filter((part) => part !== undefined);
  return new ProviderError({
    message: `${what} failed with HTTP ${response.status}${detail.length === 0 ? "" : ` (${detail.join(", ")})`}`,
    rejected,
    status: response.status,
    ...(code === undefined
      ? {}
      : {
          cause: {
            feishuCode: code,
            retryable: isRetryableFeishuFailure(response.status, code),
          },
        }),
  });
};

export const isoNow = (clock: (() => string) | undefined): string =>
  (clock ?? (() => new Date().toISOString()))();

export const plusSeconds = (now: string, seconds: number): string =>
  new Date(Date.parse(now) + seconds * 1000).toISOString();

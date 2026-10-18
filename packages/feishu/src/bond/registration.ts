import { ProviderError } from "@openma/matter/bond";
import { Effect } from "effect";
import {
  bearer,
  endpoints,
  feishuError,
  isoNow,
  isRecord,
  plusSeconds,
  requestJson,
  succeeded,
  type FeishuBrand,
  type Fetch,
  type JsonResponse,
} from "./http.js";
import {
  mintTenantAccessToken,
  type SelfBuiltAppCredentials,
} from "./tokens.js";

/**
 * One-click app registration: the user scans a QR code or opens a link,
 * confirms in Feishu, and the host receives the new self-built app's
 * credentials. This is the device-style flow behind the official SDK's
 * `registerApp` and lark-cli's `config init --new`, implemented with fetch
 * and WebCrypto streams only.
 */

const ACCOUNTS: Readonly<Record<FeishuBrand, string>> = {
  feishu: "https://accounts.feishu.cn",
  lark: "https://accounts.larksuite.com",
};
const ENDPOINT = "/oauth/v1/app/registration";
const DEFAULT_EXPIRES_IN = 600;
const DEFAULT_INTERVAL = 5;
const MAX_INTERVAL = 60;
const AVATAR_MAX = 6;

/**
 * What the confirmation page pre-configures on the app: tenant and user
 * scopes, event subscriptions, and card callbacks. `preset: false` starts
 * from the minimal base template instead of the platform default.
 */
export interface FeishuAppAddons {
  readonly preset?: boolean;
  readonly scopes?: {
    readonly tenant?: readonly string[];
    readonly user?: readonly string[];
  };
  readonly events?: {
    readonly items?: {
      readonly tenant?: readonly string[];
      readonly user?: readonly string[];
    };
  };
  readonly callbacks?: { readonly items?: readonly string[] };
}

const configError = (message: string) =>
  new ProviderError({ message, rejected: false });

const onlyKeys = (
  value: unknown,
  allowed: readonly string[],
  path: string,
): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `${path}.${key} is not allowed; allowed keys: ${allowed.join(", ")}`,
      );
    }
  }
  return value;
};

/**
 * Validates addons and rebuilds them from the known fields only. The
 * confirmation page silently drops the whole payload on any unknown key, so
 * a typo must fail here instead.
 */
export const normalizeFeishuAddons = (
  addons: FeishuAppAddons,
): FeishuAppAddons => {
  const root = onlyKeys(
    addons,
    ["preset", "scopes", "events", "callbacks"],
    "addons",
  );
  let count = 0;
  const strings = (value: unknown, path: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value))
      throw new Error(`${path} must be an array of strings`);
    value.forEach((item, index) => {
      if (typeof item !== "string" || item === "") {
        throw new Error(`${path}[${index}] must be a non-empty string`);
      }
    });
    count += value.length;
    return [...(value as string[])];
  };
  const out: {
    preset?: boolean;
    scopes?: { tenant?: string[]; user?: string[] };
    events?: { items: { tenant?: string[]; user?: string[] } };
    callbacks?: { items?: string[] };
  } = {};
  if (root.preset !== undefined) {
    if (typeof root.preset !== "boolean")
      throw new Error("addons.preset must be a boolean");
    out.preset = root.preset;
  }
  if (root.scopes !== undefined) {
    const scopes = onlyKeys(root.scopes, ["tenant", "user"], "addons.scopes");
    const tenant = strings(scopes.tenant, "addons.scopes.tenant");
    const user = strings(scopes.user, "addons.scopes.user");
    out.scopes = {
      ...(tenant === undefined ? {} : { tenant }),
      ...(user === undefined ? {} : { user }),
    };
  }
  if (root.events !== undefined) {
    const events = onlyKeys(root.events, ["items"], "addons.events");
    if (events.items !== undefined) {
      const items = onlyKeys(
        events.items,
        ["tenant", "user"],
        "addons.events.items",
      );
      const tenant = strings(items.tenant, "addons.events.items.tenant");
      const user = strings(items.user, "addons.events.items.user");
      out.events = {
        items: {
          ...(tenant === undefined ? {} : { tenant }),
          ...(user === undefined ? {} : { user }),
        },
      };
    }
  }
  if (root.callbacks !== undefined) {
    const callbacks = onlyKeys(root.callbacks, ["items"], "addons.callbacks");
    const items = strings(callbacks.items, "addons.callbacks.items");
    out.callbacks = items === undefined ? {} : { items };
  }
  if (count === 0 && root.preset !== false) {
    throw new Error(
      "addons must contain at least one scope, event, or callback",
    );
  }
  return out;
};

const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const gzip = async (text: string): Promise<Uint8Array> => {
  const stream = new Blob([new TextEncoder().encode(text)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * Encodes addons for the `addons` query parameter, the encoding the
 * platform fixes: JSON, gzip, base64, URL-safe alphabet, no padding.
 */
export const encodeFeishuAddons = (
  addons: FeishuAppAddons,
): Effect.Effect<string, ProviderError> =>
  Effect.try({
    try: () => JSON.stringify(normalizeFeishuAddons(addons)),
    catch: (cause) =>
      configError(cause instanceof Error ? cause.message : "Invalid addons"),
  }).pipe(
    Effect.flatMap((json) =>
      Effect.promise(() => gzip(json)).pipe(Effect.map(base64url)),
    ),
  );

export interface FeishuAppRegistrationInput {
  /** Defaults to `feishu`. A Lark tenant is detected while polling. */
  readonly brand?: FeishuBrand;
  /** Pre-filled app name, description, and avatar image URLs (at most six). */
  readonly name?: string;
  readonly description?: string;
  readonly avatars?: readonly string[];
  readonly addons?: FeishuAppAddons;
  /**
   * Update this existing app instead of creating one. The user picks the
   * app's new configuration on the confirmation page.
   */
  readonly appId?: string;
  /** Never offer to update an existing app. Wins over `appId`. */
  readonly createOnly?: boolean;
  /** Identifies the host in the link, such as `openma`. */
  readonly source?: string;
  readonly fetch?: Fetch;
  readonly clock?: () => string;
}

export interface FeishuAppRegistration {
  /** Keep server-side; it is what the poll exchanges for the app's secret. */
  readonly deviceCode: string;
  /** Render as a link and a QR code. */
  readonly url: string;
  readonly expiresAt: string;
  /** Seconds between polls. */
  readonly interval: number;
  /** Pass back to the first poll. */
  readonly brand: FeishuBrand;
}

/**
 * RFC 8628 answers such as `authorization_pending` arrive with HTTP 400 and
 * a JSON body, so every status is read as a body.
 */
const postRegistration = (
  fetchImpl: Fetch,
  brand: FeishuBrand,
  params: Record<string, string>,
): Effect.Effect<JsonResponse, ProviderError> =>
  requestJson(fetchImpl, `${ACCOUNTS[brand]}${ENDPOINT}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(params).toString(),
  });

const errorOf = (body: unknown): string | undefined =>
  isRecord(body) && typeof body.error === "string" ? body.error : undefined;

/**
 * Starts a one-click registration and returns the link to show the user.
 * The host then polls with `pollFeishuAppRegistration` from a background
 * job, never from a request handler loop.
 */
export const beginFeishuAppRegistration = (
  input: FeishuAppRegistrationInput = {},
): Effect.Effect<FeishuAppRegistration, ProviderError> =>
  Effect.gen(function* () {
    const brand = input.brand ?? "feishu";
    if (input.appId !== undefined && !input.appId.startsWith("cli_")) {
      return yield* Effect.fail(configError("appId must start with cli_"));
    }
    if (input.avatars !== undefined) {
      if (input.avatars.length === 0 || input.avatars.length > AVATAR_MAX) {
        return yield* Effect.fail(
          configError(`avatars must hold 1 to ${AVATAR_MAX} URLs`),
        );
      }
      if (input.avatars.some((url) => url === "")) {
        return yield* Effect.fail(
          configError("avatars must be non-empty URLs"),
        );
      }
    }
    const addons =
      input.addons === undefined
        ? undefined
        : yield* encodeFeishuAddons(input.addons);
    const now = isoNow(input.clock);
    const response = yield* postRegistration(
      input.fetch ?? globalThis.fetch,
      brand,
      {
        action: "begin",
        archetype: "PersonalAgent",
        auth_method: "client_secret",
        request_user_info: "open_id tenant_brand",
      },
    );
    const b = response.body;
    if (
      !succeeded(response) ||
      !isRecord(b) ||
      typeof b.device_code !== "string" ||
      typeof b.verification_uri_complete !== "string"
    ) {
      return yield* Effect.fail(
        feishuError("Starting the app registration", response),
      );
    }
    const url = yield* Effect.try({
      try: () => new URL(b.verification_uri_complete as string),
      catch: () => feishuError("Starting the app registration", response),
    });
    if (url.protocol !== "https:") {
      return yield* Effect.fail(
        feishuError("Starting the app registration", response),
      );
    }
    url.searchParams.set("from", "sdk");
    url.searchParams.set(
      "source",
      input.source ? `openmatter/${input.source}` : "openmatter",
    );
    url.searchParams.set("tp", "sdk");
    for (const avatar of input.avatars ?? [])
      url.searchParams.append("avatar", avatar);
    if (input.name !== undefined) url.searchParams.set("name", input.name);
    if (input.description !== undefined)
      url.searchParams.set("desc", input.description);
    if (addons !== undefined) url.searchParams.set("addons", addons);
    if (input.createOnly === true) url.searchParams.set("createOnly", "true");
    if (input.appId !== undefined)
      url.searchParams.set("clientID", input.appId);
    return {
      deviceCode: b.device_code,
      url: url.toString(),
      expiresAt: plusSeconds(
        now,
        typeof b.expires_in === "number" && b.expires_in > 0
          ? b.expires_in
          : DEFAULT_EXPIRES_IN,
      ),
      interval:
        typeof b.interval === "number" && b.interval > 0
          ? b.interval
          : DEFAULT_INTERVAL,
      brand,
    };
  });

export type FeishuAppRegistrationPoll =
  | {
      readonly status: "pending";
      readonly interval: number;
      readonly brand: FeishuBrand;
    }
  /** Poll less often from now on. */
  | {
      readonly status: "slow_down";
      readonly interval: number;
      readonly brand: FeishuBrand;
    }
  | { readonly status: "expired" }
  | { readonly status: "denied" }
  | {
      readonly status: "registered";
      readonly appId: string;
      /** Store sealed, like a pasted secret. Never log it. */
      readonly appSecret: string;
      readonly brand: FeishuBrand;
      /** The confirming user's `open_id` in the new app, when returned. */
      readonly openId?: string;
    };

/**
 * Polls a registration once. The caller keeps `brand` from the previous
 * answer: a Lark tenant is reported on the Feishu origin, and this poll
 * then asks the Lark origin once and answers with `brand: "lark"`.
 */
export const pollFeishuAppRegistration = (input: {
  readonly deviceCode: string;
  readonly interval: number;
  readonly brand: FeishuBrand;
  readonly fetch?: Fetch;
}): Effect.Effect<FeishuAppRegistrationPoll, ProviderError> =>
  Effect.gen(function* () {
    const fetchImpl = input.fetch ?? globalThis.fetch;
    let brand = input.brand;
    let response = yield* postRegistration(fetchImpl, brand, {
      action: "poll",
      device_code: input.deviceCode,
    });
    const tenantBrand = (body: unknown) =>
      isRecord(body) && isRecord(body.user_info)
        ? body.user_info.tenant_brand
        : undefined;
    if (brand === "feishu" && tenantBrand(response.body) === "lark") {
      brand = "lark";
      response = yield* postRegistration(fetchImpl, brand, {
        action: "poll",
        device_code: input.deviceCode,
      });
    }
    const b = response.body;
    if (
      isRecord(b) &&
      typeof b.client_id === "string" &&
      b.client_id.length > 0 &&
      typeof b.client_secret === "string" &&
      b.client_secret.length > 0
    ) {
      const openId =
        isRecord(b.user_info) && typeof b.user_info.open_id === "string"
          ? b.user_info.open_id
          : undefined;
      return {
        status: "registered",
        appId: b.client_id,
        appSecret: b.client_secret,
        brand,
        ...(openId === undefined ? {} : { openId }),
      } satisfies FeishuAppRegistrationPoll;
    }
    switch (errorOf(b)) {
      case "authorization_pending":
        return { status: "pending", interval: input.interval, brand };
      case "slow_down":
        return {
          status: "slow_down",
          interval: Math.min(input.interval + 5, MAX_INTERVAL),
          brand,
        };
      case "expired_token":
        return { status: "expired" };
      case "access_denied":
        return { status: "denied" };
      default:
        return yield* Effect.fail(
          feishuError("App registration poll", response),
        );
    }
  });

/** What an app needs for a Loop to work; see `feishuAgentSetup`. */
export interface FeishuAppRequirements {
  readonly scopes: readonly string[];
  readonly events: readonly string[];
}

export interface FeishuAppSetupReport {
  /** True when every check passed and nothing is unknown. */
  readonly ready: boolean;
  readonly bot: boolean;
  /** Required tenant scopes the app lacks or the tenant has not granted. */
  readonly missingScopes: readonly string[];
  /** Required events the published version does not subscribe; undefined when unreadable. */
  readonly missingEvents?: readonly string[];
  /** Human-readable fixes, one per problem, for the setup page. */
  readonly problems: readonly string[];
}

/** Reading the app's own version needs this scope, so presets include it. */
export const SELF_MANAGE_SCOPE = "application:application:self_manage";

/**
 * Checks a self-built app against requirements, for the setup page after a
 * registration or a pasted credential. Reads the tenant's scope grants
 * (`GET /open-apis/application/v6/scopes`) and the published version's
 * abilities and events (`applications/:app_id` → `app_versions/:id`). The
 * version read needs `application:application:self_manage`; without it the
 * events are reported as unknown rather than missing.
 */
export const checkFeishuAppSetup = (
  app: SelfBuiltAppCredentials,
  required: FeishuAppRequirements,
): Effect.Effect<FeishuAppSetupReport, ProviderError> =>
  Effect.gen(function* () {
    const { token } = yield* mintTenantAccessToken(app);
    const { open } = yield* endpoints(app.baseUrl);
    const fetchImpl = app.fetch ?? globalThis.fetch;
    const get = (path: string) =>
      requestJson(fetchImpl, `${open}${path}`, {
        method: "GET",
        headers: { ...bearer(token), accept: "application/json" },
      });
    const data = (response: JsonResponse) =>
      succeeded(response) &&
      isRecord(response.body) &&
      isRecord(response.body.data)
        ? response.body.data
        : undefined;

    const scopesResponse = yield* get("/open-apis/application/v6/scopes");
    const scopesData = data(scopesResponse);
    if (scopesData === undefined || !Array.isArray(scopesData.scopes)) {
      return yield* Effect.fail(
        feishuError("Reading the app scopes", scopesResponse),
      );
    }
    const granted = new Set(
      scopesData.scopes
        .filter(
          (s): s is Record<string, unknown> =>
            isRecord(s) &&
            typeof s.scope_name === "string" &&
            s.grant_status === 1,
        )
        .map((s) => s.scope_name as string),
    );
    const missingScopes = required.scopes.filter((s) => !granted.has(s));

    let bot = false;
    let events: Set<string> | undefined;
    const appData = data(
      yield* get(
        `/open-apis/application/v6/applications/${encodeURIComponent(app.appId)}?lang=en_us`,
      ),
    );
    const versionId =
      appData !== undefined &&
      isRecord(appData.app) &&
      typeof appData.app.online_version_id === "string" &&
      appData.app.online_version_id.length > 0
        ? appData.app.online_version_id
        : undefined;
    if (versionId !== undefined) {
      const versionData = data(
        yield* get(
          `/open-apis/application/v6/applications/${encodeURIComponent(app.appId)}/app_versions/${encodeURIComponent(versionId)}?lang=en_us`,
        ),
      );
      const version =
        versionData !== undefined && isRecord(versionData.app_version)
          ? versionData.app_version
          : undefined;
      if (version !== undefined) {
        bot = isRecord(version.ability) && isRecord(version.ability.bot);
        events = new Set(
          Array.isArray(version.events)
            ? version.events.filter((e): e is string => typeof e === "string")
            : [],
        );
      }
    }
    if (!bot) {
      // Unpublished or unreadable versions: fall back to the bot endpoint.
      const botResponse = yield* get("/open-apis/bot/v3/info");
      bot =
        succeeded(botResponse) &&
        isRecord(botResponse.body) &&
        isRecord(botResponse.body.bot) &&
        typeof botResponse.body.bot.open_id === "string";
    }
    const missingEvents =
      events === undefined
        ? undefined
        : required.events.filter((e) => !events.has(e));

    const problems: string[] = [];
    if (!bot) problems.push("Enable the bot ability and publish a version.");
    if (missingScopes.length > 0) {
      problems.push(
        `Add and publish these scopes: ${missingScopes.join(", ")}.`,
      );
    }
    if (missingEvents === undefined) {
      problems.push(
        versionId === undefined && appData !== undefined
          ? "Publish a version of the app."
          : `Grant ${SELF_MANAGE_SCOPE} so event subscriptions can be checked.`,
      );
    } else if (missingEvents.length > 0) {
      problems.push(
        `Subscribe these events and publish: ${missingEvents.join(", ")}.`,
      );
    }
    return {
      ready: problems.length === 0,
      bot,
      missingScopes,
      ...(missingEvents === undefined ? {} : { missingEvents }),
      problems,
    };
  });

/**
 * What the `feishu-agent` template needs from its app, as addons for the
 * registration link and as requirements for the setup check. The bot reads
 * messages addressed to it and replies; `allGroupMessages` adds reading
 * every group message, which the tenant administrator must approve.
 */
export const feishuAgentSetup = (
  options: { readonly allGroupMessages?: boolean } = {},
): {
  readonly addons: FeishuAppAddons;
  readonly requirements: FeishuAppRequirements;
} => {
  const scopes = [
    "im:message",
    "im:message.group_at_msg:readonly",
    "im:message.p2p_msg:readonly",
    "im:message:send_as_bot",
    ...(options.allGroupMessages === true ? ["im:message.group_msg"] : []),
    SELF_MANAGE_SCOPE,
  ];
  const events = ["im.message.receive_v1", "im.message.recalled_v1"];
  return {
    addons: {
      scopes: { tenant: scopes },
      events: { items: { tenant: events } },
    },
    requirements: { scopes, events },
  };
};

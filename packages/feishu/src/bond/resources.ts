import {
  ProviderError,
  checkResourceRequest,
  resourceId,
  type BondBinding,
  type BondManifest,
  type BondResource,
  type BondResourceCatalog,
} from "@openma/matter/bond";
import { Effect } from "effect";
import {
  bearer,
  endpoints,
  feishuCode,
  feishuError,
  isRecord,
  requestJson,
  succeeded,
  type Fetch,
} from "./http.js";
import {
  makeFeishuBondProvider,
  type FeishuBondProviderOptions,
} from "./provider.js";

/** Operation names used in grants and audit facts. */
export type FeishuOperation = "im_read" | "im_send" | "im_react" | "im_card";

export const feishuManifest: BondManifest = {
  provider: "feishu",
  title: "Feishu / Lark",
  docsUrl:
    "https://open.feishu.cn/document/home/introduction-to-custom-app-development/self-built-application-development-process",
  setupSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        title: "App kind",
        description:
          "A self-built app (企业自建应用) created in the customer's own tenant.",
        enum: ["self_built"],
        default: "self_built",
      },
      brand: {
        type: "string",
        title: "Brand",
        description: "Feishu (open.feishu.cn) or Lark (open.larksuite.com).",
        enum: ["feishu", "lark"],
        default: "feishu",
      },
      appId: {
        type: "string",
        title: "App ID",
        description: "Starts with cli_",
      },
      appSecret: { type: "string", title: "App secret", "x-secret": true },
      ingress: {
        type: "string",
        title: "Event delivery",
        description:
          "Long connection needs no public URL. Webhook requires an encrypt key.",
        enum: ["long_connection", "webhook"],
        default: "long_connection",
      },
      encryptKey: {
        type: "string",
        title: "Encrypt key",
        description: "Required for webhook delivery.",
        "x-secret": true,
      },
      verificationToken: {
        type: "string",
        title: "Verification token",
        "x-secret": true,
      },
      linkMethodPolicy: {
        type: "string",
        title: "Link methods",
        description:
          "OAuth covers both device flow and redirect authorization; Feishu has no personal access tokens.",
        enum: ["oauth_only"],
        default: "oauth_only",
      },
      principalPolicy: {
        type: "string",
        title: "Principal policy",
        enum: ["user_only", "user", "app"],
        default: "user",
      },
      allowUserPrincipalOutput: {
        type: "boolean",
        title: "Allow writes as the linked user",
        default: false,
      },
    },
    required: [
      "kind",
      "brand",
      "appId",
      "appSecret",
      "ingress",
      "linkMethodPolicy",
      "principalPolicy",
    ],
  },
  linkMethods: ["device", "oauth"],
  resourceKinds: [
    {
      kind: "chat",
      title: "Chat",
      operations: [
        {
          name: "im_read",
          description: "Read messages in the chat",
          access: "read",
        },
        {
          name: "im_send",
          description: "Send and reply to messages",
          access: "write",
        },
        { name: "im_react", description: "Add reactions", access: "write" },
        {
          name: "im_card",
          description: "Send and update interactive cards",
          access: "write",
        },
      ],
    },
  ],
};

/**
 * Checks pasted setup values before any network call. Returns
 * human-readable problems; empty means the values are well formed.
 */
export const feishuSetupProblems = (
  values: Readonly<Record<string, unknown>>,
): string[] => {
  const problems: string[] = [];
  const text = (key: string) =>
    typeof values[key] === "string" && (values[key] as string).length > 0
      ? (values[key] as string)
      : undefined;
  if (values.kind !== "self_built") problems.push("kind must be self_built");
  if (values.brand !== "feishu" && values.brand !== "lark") {
    problems.push("brand must be feishu or lark");
  }
  const appId = text("appId");
  if (appId === undefined || !appId.startsWith("cli_")) {
    problems.push("appId must start with cli_");
  }
  if (text("appSecret") === undefined) problems.push("appSecret is required");
  if (values.ingress !== "long_connection" && values.ingress !== "webhook") {
    problems.push("ingress must be long_connection or webhook");
  }
  if (values.ingress === "webhook" && text("encryptKey") === undefined) {
    problems.push("webhook ingress requires encryptKey");
  }
  return problems;
};

const CHAT_ID = /^oc_[A-Za-z0-9]+$/;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;
/** The chat does not exist, or the bot is not in it or cannot see it. */
const NOT_VISIBLE = new Set([232006, 232010, 232011, 232034]);

const toChat = (id: string, body: unknown): BondResource => ({
  id: resourceId("chat", id),
  kind: "chat",
  title:
    isRecord(body) && typeof body.name === "string" && body.name.length > 0
      ? body.name
      : id,
});

export interface FeishuResourceCatalogOptions {
  readonly fetch?: Fetch;
}

/**
 * Chats as Bond resources, with IDs `chat:<chat_id>`. `chat_id` (`oc_…`) is
 * stable across renames. Both calls use the bot's tenant token: `list`
 * returns the chats the bot is in, and `validate` succeeds only for a chat
 * the bot can see. Feishu's chat list has no name search, so `query`
 * filters the returned page.
 */
export const makeFeishuResourceCatalog = (
  options: FeishuResourceCatalogOptions = {},
): BondResourceCatalog => {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return {
    list: ({ config, token, query, cursor, limit }) =>
      Effect.gen(function* () {
        const { open } = yield* endpoints(config.baseUrl);
        const url = new URL("/open-apis/im/v1/chats", open);
        url.searchParams.set(
          "page_size",
          String(Math.min(Math.max(limit ?? DEFAULT_PAGE, 1), MAX_PAGE)),
        );
        if (cursor !== undefined && cursor !== "") {
          url.searchParams.set("page_token", cursor);
        }
        const response = yield* requestJson(fetchImpl, url.toString(), {
          method: "GET",
          headers: { ...bearer(token), accept: "application/json" },
        });
        const data = isRecord(response.body) ? response.body.data : undefined;
        if (!succeeded(response) || !isRecord(data)) {
          return yield* Effect.fail(feishuError("Feishu chat list", response));
        }
        const rows = Array.isArray(data.items) ? data.items : [];
        const needle = query?.trim().toLowerCase() ?? "";
        const items = rows.flatMap((row) => {
          if (!isRecord(row) || typeof row.chat_id !== "string") return [];
          const chat = toChat(row.chat_id, row);
          return needle === "" || chat.title.toLowerCase().includes(needle)
            ? [chat]
            : [];
        });
        return data.has_more === true &&
          typeof data.page_token === "string" &&
          data.page_token !== ""
          ? { items, nextCursor: data.page_token }
          : { items };
      }),
    validate: ({ config, token, resource, operations }) =>
      Effect.gen(function* () {
        const checked = checkResourceRequest(
          feishuManifest,
          resource,
          operations,
        );
        if (!checked.ok) return checked;
        if (!CHAT_ID.test(checked.key)) {
          return {
            ok: false as const,
            reason: "malformed_id" as const,
            message: "Feishu chat resources use the chat ID (oc_…)",
          };
        }
        const { open } = yield* endpoints(config.baseUrl);
        const url = new URL(`/open-apis/im/v1/chats/${checked.key}`, open);
        const response = yield* requestJson(fetchImpl, url.toString(), {
          method: "GET",
          headers: { ...bearer(token), accept: "application/json" },
        });
        const code = feishuCode(response.body);
        if (
          response.status === 404 ||
          (code !== undefined && NOT_VISIBLE.has(code))
        ) {
          return {
            ok: false as const,
            reason: "not_found" as const,
            message: `Chat ${checked.key} is not visible to the bot`,
          };
        }
        const data = isRecord(response.body) ? response.body.data : undefined;
        if (!succeeded(response) || !isRecord(data)) {
          return yield* Effect.fail(
            response.status >= 200 && response.status < 300
              ? new ProviderError({
                  message: "Feishu chat lookup returned no chat",
                  rejected: false,
                })
              : feishuError("Feishu chat lookup", response),
          );
        }
        return { ok: true as const, resource: toChat(checked.key, data) };
      }),
  };
};

/** The provider, manifest, and resource catalog a host registers for Feishu. */
export const makeFeishuBinding = (
  options: FeishuBondProviderOptions = {},
): BondBinding => ({
  manifest: feishuManifest,
  provider: makeFeishuBondProvider(options),
  resources: makeFeishuResourceCatalog(
    options.fetch === undefined ? {} : { fetch: options.fetch },
  ),
});

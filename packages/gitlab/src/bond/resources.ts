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
import type { GitLabOperation } from "./classify.js";
import {
  bearer,
  isRecord,
  requestJson,
  statusError,
  type Fetch,
} from "./http.js";
import {
  makeGitLabBondProvider,
  type GitLabBondProviderOptions,
} from "./provider.js";

/** Minimum GitLab access level per operation: 20 Reporter, 30 Developer. */
export const GITLAB_MIN_ACCESS_LEVEL: Readonly<
  Record<GitLabOperation, number>
> = {
  fetch: 20,
  read: 20,
  push: 30,
  open_mr: 30,
  comment_mr: 30,
};

export const gitlabManifest: BondManifest = {
  provider: "gitlab",
  title: "GitLab",
  docsUrl: "https://docs.gitlab.com/integration/oauth_provider/",
  setupSchema: {
    type: "object",
    properties: {
      baseUrl: {
        type: "string",
        title: "Instance URL",
        format: "uri",
        description:
          "Canonical https origin, such as https://gitlab.example.com",
      },
      oauthClientId: {
        type: "string",
        title: "OAuth application ID",
        description:
          "Optional. Without an OAuth application, users link with personal access tokens.",
      },
      oauthClientSecret: {
        type: "string",
        title: "OAuth application secret",
        "x-secret": true,
      },
      linkMethodPolicy: {
        type: "string",
        title: "Link methods",
        enum: ["pat_only", "oauth_only", "oauth_preferred"],
        default: "oauth_preferred",
      },
      principalPolicy: {
        type: "string",
        title: "Principal policy",
        enum: ["user_only", "user", "app"],
        default: "user_only",
      },
      maxPatLifetimeDays: {
        type: "integer",
        title: "Maximum personal access token lifetime, in days",
        minimum: 1,
        maximum: 365,
        default: 90,
      },
      allowUserPrincipalOutput: {
        type: "boolean",
        title: "Allow writes as the linked user",
        default: false,
      },
    },
    required: ["baseUrl", "linkMethodPolicy", "principalPolicy"],
  },
  linkMethods: ["oauth", "pat"],
  resourceKinds: [
    {
      kind: "project",
      title: "Project",
      operations: [
        {
          name: "fetch",
          description: "Clone and fetch over git",
          access: "read",
        },
        {
          name: "read",
          description: "Read the project through the REST API",
          access: "read",
        },
        { name: "push", description: "Push branches", access: "write" },
        {
          name: "open_mr",
          description: "Open merge requests",
          access: "write",
        },
        {
          name: "comment_mr",
          description: "Comment on merge requests",
          access: "write",
        },
      ],
    },
  ],
};

const PROJECT_ID = /^[1-9][0-9]{0,18}$/;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 100;

const toResource = (body: unknown): BondResource | undefined => {
  if (!isRecord(body) || typeof body.id !== "number") return undefined;
  const title =
    typeof body.path_with_namespace === "string"
      ? body.path_with_namespace
      : typeof body.name === "string"
        ? body.name
        : String(body.id);
  return {
    id: resourceId("project", body.id),
    kind: "project",
    title,
    ...(typeof body.web_url === "string" ? { url: body.web_url } : {}),
  };
};

const accessLevel = (body: Record<string, unknown>): number => {
  const permissions = isRecord(body.permissions) ? body.permissions : {};
  const level = (key: string) => {
    const entry = permissions[key];
    return isRecord(entry) && typeof entry.access_level === "number"
      ? entry.access_level
      : 0;
  };
  return Math.max(level("project_access"), level("group_access"));
};

export interface GitLabResourceCatalogOptions {
  readonly fetch?: Fetch;
}

/**
 * Projects as Bond resources, with IDs `project:<numeric id>`. Paths are
 * display data only. `list` returns projects where the token holds at least
 * Reporter; `validate` checks the access level each operation needs and
 * refuses writes to archived projects. An instance administrator without a
 * membership reports no access level and is treated as having none.
 */
export const makeGitLabResourceCatalog = (
  options: GitLabResourceCatalogOptions = {},
): BondResourceCatalog => {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return {
    list: ({ config, token, query, cursor, limit }) =>
      Effect.gen(function* () {
        const perPage = Math.min(Math.max(limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
        const page =
          cursor !== undefined && /^[1-9][0-9]*$/.test(cursor) ? cursor : "1";
        const url = new URL("/api/v4/projects", config.baseUrl);
        url.searchParams.set("membership", "true");
        url.searchParams.set("min_access_level", "20");
        url.searchParams.set("simple", "true");
        url.searchParams.set("order_by", "last_activity_at");
        url.searchParams.set("per_page", String(perPage));
        url.searchParams.set("page", page);
        if (query !== undefined && query.trim() !== "") {
          url.searchParams.set("search", query.trim());
        }
        const response = yield* requestJson(fetchImpl, url.toString(), {
          headers: bearer(token),
        });
        if (response.status < 200 || response.status >= 300) {
          return yield* Effect.fail(
            statusError("GitLab project list", response),
          );
        }
        const rows = Array.isArray(response.body) ? response.body : [];
        const items = rows.flatMap((row) => {
          const resource = toResource(row);
          return resource === undefined ? [] : [resource];
        });
        const next = response.headers?.get("x-next-page") ?? "";
        return /^[1-9][0-9]*$/.test(next)
          ? { items, nextCursor: next }
          : { items };
      }),
    validate: ({ config, token, resource, operations }) =>
      Effect.gen(function* () {
        const checked = checkResourceRequest(
          gitlabManifest,
          resource,
          operations,
        );
        if (!checked.ok) return checked;
        if (!PROJECT_ID.test(checked.key)) {
          return {
            ok: false as const,
            reason: "malformed_id" as const,
            message: "GitLab project resources use the numeric project ID",
          };
        }
        const url = new URL(`/api/v4/projects/${checked.key}`, config.baseUrl);
        const response = yield* requestJson(fetchImpl, url.toString(), {
          headers: bearer(token),
        });
        if (response.status === 404 || response.status === 403) {
          return {
            ok: false as const,
            reason: "not_found" as const,
            message: `Project ${checked.key} is not visible to this token`,
          };
        }
        if (
          response.status < 200 ||
          response.status >= 300 ||
          !isRecord(response.body)
        ) {
          return yield* Effect.fail(
            statusError("GitLab project lookup", response),
          );
        }
        const project = toResource(response.body);
        if (project === undefined || project.id !== resource) {
          return yield* Effect.fail(
            new ProviderError({
              message: "GitLab project lookup returned a different project",
              rejected: false,
            }),
          );
        }
        const required = Math.max(
          0,
          ...operations.map(
            (op) => GITLAB_MIN_ACCESS_LEVEL[op as GitLabOperation] ?? Infinity,
          ),
        );
        const held = accessLevel(response.body);
        if (held < required) {
          return {
            ok: false as const,
            reason: "insufficient_access" as const,
            message: `Needs GitLab access level ${required}; the token holds ${held}`,
          };
        }
        const writes = operations.some(
          (op) =>
            checked.kind.operations.find((o) => o.name === op)?.access ===
            "write",
        );
        if (writes && response.body.archived === true) {
          return {
            ok: false as const,
            reason: "insufficient_access" as const,
            message: `Project ${checked.key} is archived`,
          };
        }
        return { ok: true as const, resource: project };
      }),
  };
};

/** The provider, manifest, and resource catalog a host registers for GitLab. */
export const makeGitLabBinding = (
  options: GitLabBondProviderOptions = {},
): BondBinding => ({
  manifest: gitlabManifest,
  provider: makeGitLabBondProvider(options),
  resources: makeGitLabResourceCatalog(
    options.fetch === undefined ? {} : { fetch: options.fetch },
  ),
});

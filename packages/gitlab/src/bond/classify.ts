// Request classification for application-side GitLab proxies. The
// application resolves every project reference to a numeric project ID and
// checks the Session's grant before forwarding anything.
//
// Forward a rebuilt URL, never the raw request path: `/api/v4/projects/<id>`
// plus `restTail` for REST, and the resolved `path_with_namespace` plus the
// git endpoint for smart HTTP. Then GitLab sees exactly what was classified.

export type GitLabOperation =
  "fetch" | "push" | "read" | "open_mr" | "comment_mr";

/**
 * A normalized project reference. Paths are lower-cased and stripped of
 * `.git`; numeric IDs stay numeric. Both forms name one project only after
 * the application resolves them through GitLab.
 */
export type ProjectRef =
  | { readonly kind: "id"; readonly id: number }
  | { readonly kind: "path"; readonly path: string };

export type GitLabRequestClass =
  | {
      readonly allow: true;
      readonly projectRef: ProjectRef;
      readonly operation: GitLabOperation;
      /** `git` for smart HTTP, `rest` for `/api/v4`. */
      readonly surface: "git" | "rest";
      /**
       * For `rest`: the validated path after `/api/v4/projects/<ref>`, to
       * append to the resolved numeric project ID. For `open_mr`, the proxy
       * must also check the body with `mergeRequestBodyProblem`.
       */
      readonly restTail?: string;
    }
  | { readonly allow: false; readonly reason: string };

const deny = (reason: string): GitLabRequestClass => ({ allow: false, reason });

const normalizePath = (raw: string): string | undefined => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  const path = decoded
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  const segments = path.split("/");
  if (
    segments.length < 2 ||
    segments.some(
      (s) => s === "" || s === "." || s === ".." || !/^[\w.-]+$/.test(s),
    )
  ) {
    return undefined;
  }
  return path;
};

const projectRefOf = (raw: string): ProjectRef | undefined =>
  /^\d+$/.test(raw)
    ? { kind: "id", id: Number(raw) }
    : (() => {
        const path = normalizePath(raw);
        return path === undefined ? undefined : { kind: "path", path };
      })();

/**
 * REST reads, by exact shape. A branch name may carry encoded slashes
 * (`feature%2Fx`), and nothing else is percent-encoded.
 */
const READ_TAILS = [
  /^$/,
  /^\/merge_requests$/,
  /^\/merge_requests\/\d+(\/(notes|commits|changes|diffs|approvals))?$/,
  /^\/repository\/branches$/,
  /^\/repository\/branches\/([\w.-]|%2[fF])+$/,
  /^\/repository\/commits$/,
  /^\/repository\/commits\/[0-9a-f]{7,64}$/,
];

const GIT_ROUTE =
  /^\/(.+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/i;

/**
 * Classifies one request in GitLab's own URL shape. Allows git smart HTTP
 * fetch and push, REST reads of a project, merge request creation, and
 * merge request notes. Denies GraphQL, LFS, archives, raw files, and every
 * other route.
 */
export const classifyGitLabRequest = (
  method: string,
  url: string | URL,
): GitLabRequestClass => {
  const u =
    typeof url === "string" ? new URL(url, "https://gitlab.invalid") : url;
  const verb = method.toUpperCase();
  const path = u.pathname;
  if (path.includes("/../") || path.endsWith("/.."))
    return deny("path traversal");
  // Encoded dots and backslashes have no legitimate use in allowed routes.
  if (/%2e|%5c/i.test(path)) return deny("encoded traversal characters");

  if (/^\/api\/graphql\/?$/i.test(path)) return deny("GraphQL is not proxied");
  if (/\/info\/lfs(\/|$)/i.test(path)) return deny("LFS is not proxied");

  const git = path.match(GIT_ROUTE);
  if (git !== null && !/^\/api\//i.test(path)) {
    const [, rawProject, endpoint] = git;
    const ref =
      rawProject === undefined ? undefined : normalizePath(rawProject);
    if (ref === undefined) return deny("invalid project path");
    const service =
      endpoint?.toLowerCase() === "info/refs"
        ? u.searchParams.get("service")
        : endpoint?.toLowerCase();
    const operation =
      service === "git-upload-pack"
        ? "fetch"
        : service === "git-receive-pack"
          ? "push"
          : undefined;
    if (operation === undefined) return deny("git service not allowed");
    const expected = endpoint?.toLowerCase() === "info/refs" ? "GET" : "POST";
    if (verb !== expected) return deny(`method ${verb} not allowed`);
    return {
      allow: true,
      projectRef: { kind: "path", path: ref },
      operation,
      surface: "git",
    };
  }

  const rest = path.match(/^\/api\/v4\/projects\/([^/]+)(\/.*)?$/i);
  if (rest !== null) {
    const [, rawProject, rest2] = rest;
    const projectRef =
      rawProject === undefined ? undefined : projectRefOf(rawProject);
    if (projectRef === undefined) return deny("invalid project reference");
    const tail = (rest2 ?? "").replace(/\/$/, "");
    if (tail.includes("..")) return deny("path traversal");
    const allow = (operation: GitLabOperation): GitLabRequestClass => ({
      allow: true,
      projectRef,
      operation,
      surface: "rest",
      restTail: tail,
    });
    if (verb === "GET" && READ_TAILS.some((re) => re.test(tail))) {
      return allow("read");
    }
    if (verb === "POST") {
      // Grape merges query parameters into the request parameters, so a
      // write could carry `target_project_id` (or anything else) past a body
      // check. Writes take no query string.
      if (u.search !== "") return deny("query parameters on a write");
      if (tail === "/merge_requests") return allow("open_mr");
      if (/^\/merge_requests\/\d+\/notes$/.test(tail)) {
        return allow("comment_mr");
      }
    }
    return deny("REST route not allowed");
  }
  return deny("route not allowed");
};

/**
 * GitLab lets `POST /projects/:id/merge_requests` name another project in
 * `target_project_id`, so the URL alone does not bound where the merge
 * request opens. Returns the reason to deny, or undefined when the body
 * targets the classified project.
 *
 * Pass the parsed JSON object or form body and the numeric ID the URL's
 * project reference resolved to, then forward the body you checked
 * (re-serialized), never the raw bytes: parsers disagree on repeated keys.
 * For the same reason a form that repeats `target_project_id`, or uses a
 * variant such as `target_project_id[]`, is denied.
 */
export const mergeRequestBodyProblem = (
  body: unknown,
  resolvedProjectId: number,
): string | undefined => {
  let target: unknown;
  if (body instanceof URLSearchParams) {
    const keys = [...body.keys()].filter((k) =>
      k.startsWith("target_project_id"),
    );
    if (keys.some((k) => k !== "target_project_id")) {
      return "target_project_id has an unsupported form";
    }
    if (keys.length > 1) return "target_project_id appears more than once";
    target = body.get("target_project_id") ?? undefined;
  } else if (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body)
  ) {
    const record = body as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (k) => k.startsWith("target_project_id") && k !== "target_project_id",
      )
    ) {
      return "target_project_id has an unsupported form";
    }
    target = record.target_project_id;
  } else if (body === undefined || body === null) {
    target = undefined;
  } else {
    return "merge request body is not an object";
  }
  if (target === undefined || target === "") return undefined;
  const id =
    typeof target === "number"
      ? target
      : typeof target === "string" && /^\d+$/.test(target)
        ? Number(target)
        : Number.NaN;
  if (!Number.isSafeInteger(id)) return "target_project_id is not a project ID";
  return id === resolvedProjectId
    ? undefined
    : "target_project_id names another project";
};

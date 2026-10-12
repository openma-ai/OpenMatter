// Request classification for application-side GitLab proxies. The
// application resolves every project reference to a numeric project ID and
// checks the Session's grant before forwarding anything.

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

  if (/^\/api\/graphql\/?$/i.test(path)) return deny("GraphQL is not proxied");
  if (/\/info\/lfs(\/|$)/i.test(path)) return deny("LFS is not proxied");

  const git = path.match(GIT_ROUTE);
  if (git !== null && !path.startsWith("/api/")) {
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

  const rest = path.match(/^\/api\/v4\/projects\/([^/]+)(\/.*)?$/);
  if (rest !== null) {
    const [, rawProject, rest2] = rest;
    const projectRef =
      rawProject === undefined ? undefined : projectRefOf(rawProject);
    if (projectRef === undefined) return deny("invalid project reference");
    const tail = rest2 ?? "";
    if (
      verb === "GET" &&
      /^(\/(merge_requests|repository\/branches|repository\/commits)(\/[\w.%-]+)*)?\/?$/.test(
        tail,
      )
    ) {
      return { allow: true, projectRef, operation: "read", surface: "rest" };
    }
    if (verb === "POST" && /^\/merge_requests\/?$/.test(tail)) {
      return { allow: true, projectRef, operation: "open_mr", surface: "rest" };
    }
    if (verb === "POST" && /^\/merge_requests\/\d+\/notes\/?$/.test(tail)) {
      return {
        allow: true,
        projectRef,
        operation: "comment_mr",
        surface: "rest",
      };
    }
    return deny("REST route not allowed");
  }
  return deny("route not allowed");
};

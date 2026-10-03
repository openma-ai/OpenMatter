export const githubRepository = (
  repository: string,
): { owner: string; repo: string } => {
  const url = new URL(repository);
  if (url.protocol !== "https:" || url.hostname !== "github.com")
    throw new Error("Thread branches require an https://github.com repository");
  const [owner, repo] = url.pathname
    .replace(/^\//, "")
    .replace(/\.git$/, "")
    .split("/");
  if (!owner || !repo) throw new Error("Invalid GitHub repository URL");
  return { owner, repo: repo };
};

export const ensureGithubBranch = async (options: {
  readonly token: string;
  readonly repository: string;
  readonly base: string;
  readonly branch: string;
  readonly fetch?: typeof fetch;
  readonly apiBase?: string;
}): Promise<void> => {
  const { owner, repo } = githubRepository(options.repository);
  const fetchImpl = options.fetch ?? fetch;
  const api = options.apiBase ?? "https://api.github.com";
  const headers = {
    authorization: `Bearer ${options.token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "openmatter-project-worker",
  };
  const base = options.base === "HEAD" ? "HEAD" : options.base;
  const ref = await fetchImpl(
    `${api}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(base)}`,
    {
      headers,
    },
  );
  if (!ref.ok)
    throw new Error(`GitHub base ${base} is unavailable (${ref.status})`);
  const sha = ((await ref.json()) as { object?: { sha?: string } }).object?.sha;
  if (!sha) throw new Error("GitHub base ref has no commit");
  const created = await fetchImpl(`${api}/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ref: `refs/heads/${options.branch}`, sha }),
  });
  if (created.status === 422) return;
  if (!created.ok)
    throw new Error(
      `GitHub did not create ${options.branch} (${created.status})`,
    );
};

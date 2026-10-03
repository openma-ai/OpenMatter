export interface WorkerConfig {
  readonly openmaUrl: string;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly store: "sqlite" | "mysql";
  readonly dataDir: string;
  readonly mysqlUrl?: string;
  /** Set for the current backchat handshake, which calls GET /info with no tenant. */
  readonly workspaceId?: string;
  readonly credentialKey: Buffer;
  readonly githubToken?: string;
  readonly tokenQuota?: number;
  readonly infoTimeoutMs: number;
}

const required = (name: string, value: string | undefined): string => {
  if (!value?.trim()) throw new Error(`Set ${name}`);
  return value.trim();
};

export const workerConfigFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): WorkerConfig => {
  const openmaUrl = required(
    "PROJECT_WORKER_OPENMA_URL",
    env.PROJECT_WORKER_OPENMA_URL,
  ).replace(/\/$/, "");
  const listen = env.PROJECT_WORKER_LISTEN?.trim() || "127.0.0.1:8788";
  const [host, portText] = listen.includes(":")
    ? [
        listen.slice(0, listen.lastIndexOf(":")),
        listen.slice(listen.lastIndexOf(":") + 1),
      ]
    : ["127.0.0.1", listen];
  const store =
    env.PROJECT_WORKER_STORE?.trim() === "mysql" ? "mysql" : "sqlite";
  const keyText = required(
    "PROJECT_WORKER_CREDENTIAL_KEY",
    env.PROJECT_WORKER_CREDENTIAL_KEY,
  );
  const credentialKey = Buffer.from(keyText, "base64");
  if (credentialKey.length !== 32)
    throw new Error("PROJECT_WORKER_CREDENTIAL_KEY must be 32 bytes of base64");
  const quota = env.PROJECT_WORKER_TOKEN_QUOTA?.trim();
  return {
    openmaUrl,
    listenHost: host || "127.0.0.1",
    listenPort: Number(portText),
    store,
    dataDir: env.PROJECT_WORKER_DATA_DIR?.trim() || ".data/project-worker",
    ...(store === "mysql"
      ? {
          mysqlUrl: required(
            "PROJECT_WORKER_MYSQL_URL",
            env.PROJECT_WORKER_MYSQL_URL,
          ),
        }
      : {}),
    ...(env.PROJECT_WORKER_WORKSPACE_ID?.trim()
      ? { workspaceId: env.PROJECT_WORKER_WORKSPACE_ID.trim() }
      : {}),
    credentialKey,
    ...(env.PROJECT_WORKER_GITHUB_TOKEN?.trim()
      ? { githubToken: env.PROJECT_WORKER_GITHUB_TOKEN.trim() }
      : {}),
    ...(quota ? { tokenQuota: Number(quota) } : {}),
    infoTimeoutMs: 10_000,
  };
};

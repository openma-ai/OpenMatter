import type {
  AgentCapabilities,
  AgentDriver,
  AgentSessionHandle,
  AgentSessionInput,
  AgentTurnHandle,
  AgentTurnInput,
} from "@openmatter/core";
import type { OperationRef } from "@openmatter/core";

export interface OpenMAEventLike {
  readonly type: string;
  readonly data: unknown;
}

export interface OpenMASessionHandleLike {
  readonly connectorId: string;
  readonly externalSessionId: string;
  readonly placement: "local" | "remote" | "managed";
  readonly resumeToken?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface OpenMAConnectorLike {
  readonly id: string;
  capabilities(): Promise<AgentCapabilities>;
  open(input: {
    agentId: string;
    cwd?: string;
    additionalDirectories?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<OpenMASessionHandleLike>;
  execute(
    session: OpenMASessionHandleLike,
    input: {
      readonly runId: string;
      readonly attemptId: string;
      readonly contextDigest: string;
      readonly content: AgentTurnInput["content"];
      readonly grants?: readonly string[];
    },
  ): AsyncIterable<OpenMAEventLike>;
  send(
    session: OpenMASessionHandleLike,
    command:
      | { readonly type: "turn.cancel"; readonly attemptId?: string }
      | { readonly type: "session.close" },
  ): Promise<void>;
  close(session: OpenMASessionHandleLike): Promise<void>;
}

interface EventQueue<T> {
  readonly iterable: AsyncIterable<T>;
  push(value: T): void;
  end(): void;
  fail(error: unknown): void;
}

function createEventQueue<T>(): EventQueue<T> {
  const buffered: T[] = [];
  const waiting: Array<{
    resolve(value: IteratorResult<T>): void;
    reject(error: unknown): void;
  }> = [];
  let ended = false;
  let failure: unknown;

  const settle = () => {
    while (waiting.length > 0 && buffered.length > 0) {
      waiting.shift()?.resolve({ value: buffered.shift()!, done: false });
    }
    if (buffered.length > 0 || !ended) return;
    while (waiting.length > 0) {
      const waiter = waiting.shift()!;
      if (failure === undefined) waiter.resolve({ value: undefined, done: true });
      else waiter.reject(failure);
    }
  };

  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            if (buffered.length > 0) {
              return Promise.resolve({ value: buffered.shift()!, done: false });
            }
            if (ended) {
              return failure === undefined
                ? Promise.resolve({ value: undefined, done: true })
                : Promise.reject(failure);
            }
            return new Promise((resolve, reject) => {
              waiting.push({ resolve, reject });
            });
          },
        };
      },
    },
    push(value) {
      if (ended) return;
      buffered.push(value);
      settle();
    },
    end() {
      ended = true;
      settle();
    },
    fail(error) {
      failure = error;
      ended = true;
      settle();
    },
  };
}

function serializeGrant(operation: OperationRef): string {
  return JSON.stringify({
    profile: {
      id: operation.profile.id,
      version: operation.profile.version,
      digest: operation.profile.digest,
    },
    surfaceId: operation.surfaceId,
    authorityId: operation.authorityId,
    operationId: operation.operationId,
  });
}

function terminalResult(event: OpenMAEventLike) {
  if (event.type === "turn.completed" || event.type === "session.idle") {
    return { status: "completed" as const };
  }
  if (event.type === "turn.cancelled") {
    return { status: "cancelled" as const };
  }
  if (event.type === "turn.failed" || event.type === "session.error") {
    const data = event.data as { message?: unknown; reason?: unknown } | undefined;
    const reason = data?.reason ?? data?.message;
    return {
      status: "failed" as const,
      ...(typeof reason === "string" ? { reason } : {}),
    };
  }
  return undefined;
}

function connectorSession(session: AgentSessionHandle): OpenMASessionHandleLike {
  return {
    connectorId: session.driverId,
    externalSessionId: session.externalSessionId,
    placement: session.placement,
    ...(session.resumeToken ? { resumeToken: session.resumeToken } : {}),
  };
}

export function createOpenMAAgentDriver(
  connector: OpenMAConnectorLike,
): AgentDriver<OpenMAEventLike> {
  return {
    id: connector.id,
    capabilities: () => connector.capabilities(),
    openSession: async (input: AgentSessionInput): Promise<AgentSessionHandle> => {
      const opened = await connector.open({
        agentId: input.agentId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.additionalDirectories
          ? { additionalDirectories: [...input.additionalDirectories] }
          : {}),
        ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
      });
      return {
        driverId: connector.id,
        externalSessionId: opened.externalSessionId,
        placement: opened.placement,
        ...(opened.resumeToken ? { resumeToken: opened.resumeToken } : {}),
      };
    },
    runTurn(
      session: AgentSessionHandle,
      input: AgentTurnInput,
    ): AgentTurnHandle<OpenMAEventLike> {
      const external = connectorSession(session);
      const queue = createEventQueue<OpenMAEventLike>();
      let terminal: ReturnType<typeof terminalResult>;
      const result = (async () => {
        try {
          for await (const event of connector.execute(external, {
            runId: input.turnId,
            attemptId: input.executionId,
            contextDigest: input.contextDigest,
            content: input.content,
            grants: input.grants.map(serializeGrant),
          })) {
            queue.push(event);
            terminal ??= terminalResult(event);
          }
          queue.end();
          return terminal ?? { status: "failed" as const, reason: "missing_terminal" };
        } catch (error) {
          queue.fail(error);
          return {
            status: "failed" as const,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      })();

      return {
        events: queue.iterable,
        result,
        cancel: async () =>
          connector.send(external, {
            type: "turn.cancel",
            attemptId: input.executionId,
          }),
      };
    },
    closeSession: (session) => connector.close(connectorSession(session)),
  };
}

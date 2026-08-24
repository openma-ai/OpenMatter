import {
  createAgentSessionHandle,
  immutableJson,
  type AgentContent,
  type AgentCapabilities as ConnectorCapabilities,
  type AgentSessionHandle as ConnectorSessionHandle,
  type JsonObject,
  type OpenMAAgentConnector,
} from "@openma/common/agent-contract";
import {
  AgentDriverError,
  AgentSessionUnavailableError,
  OpenMAEventSchema,
  type AgentCapabilities,
  type AgentDriver,
  type AgentSessionHandle,
  type OpenMAEvent,
} from "@openmatter/agent";
import type { ContextProjection, JsonValue } from "@openmatter/core";
import { Effect, Schema, Stream } from "effect";

export interface ClaudeAgentDriverOptions {
  readonly connector: OpenMAAgentConnector;
  readonly agentId: string;
  readonly id?: string;
  readonly content?: (context: ContextProjection) => AgentContent;
  readonly session?: {
    readonly cwd?: string;
    readonly additionalDirectories?: readonly string[];
    readonly metadata?: JsonObject;
  };
  /** Distinguish a missing/expired remote Session from transient transport errors. */
  readonly isSessionUnavailable?: (cause: unknown) => boolean;
}

const driverError = (message: string, cause: unknown) =>
  new AgentDriverError({ message, cause });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface DurableConnectorHandle {
  readonly schemaVersion: "openmatter.connector-handle.v1";
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly generation: number;
  readonly connector: ConnectorSessionHandle;
}

const durableHandleFrom = (
  handle: AgentSessionHandle,
): DurableConnectorHandle => {
  if (
    !isRecord(handle.raw) ||
    handle.raw.schemaVersion !== "openmatter.connector-handle.v1" ||
    typeof handle.raw.sessionId !== "string" ||
    typeof handle.raw.idempotencyKey !== "string" ||
    !Number.isSafeInteger(handle.raw.generation) ||
    !isRecord(handle.raw.connector)
  ) {
    throw new TypeError(
      "Agent Session handle does not contain an OpenMA connector handle",
    );
  }
  const connector = handle.raw.connector;
  const { connectorId, externalSessionId, placement, resumeToken, metadata } =
    connector;
  if (
    typeof connectorId !== "string" ||
    typeof externalSessionId !== "string" ||
    !["local", "remote", "managed"].includes(String(placement)) ||
    (resumeToken !== undefined && typeof resumeToken !== "string") ||
    (metadata !== undefined && !isRecord(metadata))
  ) {
    throw new TypeError(
      "Agent Session handle is not a valid OpenMA connector handle",
    );
  }
  const portableConnector = createAgentSessionHandle({
    connectorId,
    externalSessionId,
    placement: placement as ConnectorSessionHandle["placement"],
    ...(resumeToken === undefined ? {} : { resumeToken }),
    ...(metadata === undefined ? {} : { metadata: metadata as JsonObject }),
  });
  return immutableJson({
    schemaVersion: "openmatter.connector-handle.v1",
    sessionId: handle.raw.sessionId,
    idempotencyKey: handle.raw.idempotencyKey,
    generation: handle.raw.generation as number,
    connector: portableConnector,
  });
};

const connectorHandleFrom = (
  handle: AgentSessionHandle,
): ConnectorSessionHandle => durableHandleFrom(handle).connector;

const driverHandleFrom = (
  handle: ConnectorSessionHandle,
  identity: Pick<
    DurableConnectorHandle,
    "sessionId" | "idempotencyKey" | "generation"
  >,
): AgentSessionHandle => {
  const portable = createAgentSessionHandle(handle);
  const stored = immutableJson({
    schemaVersion: "openmatter.connector-handle.v1",
    ...identity,
    connector: portable,
  });
  return {
    id: identity.sessionId,
    raw: stored as unknown as JsonValue,
  };
};

const defaultContent = (context: ContextProjection): AgentContent =>
  JSON.stringify({
    scopeId: context.scopeId,
    workThreadId: context.workThreadId,
    items: context.items,
    grants: context.grants,
  });

const validateConnectorEvent = (
  event: unknown,
): Effect.Effect<OpenMAEvent, AgentDriverError> => {
  if (!Schema.is(OpenMAEventSchema)(event)) {
    return Effect.fail(
      new AgentDriverError({
        message: "Claude Agent Connector emitted an invalid OpenMAEvent",
      }),
    );
  }
  return Effect.try({
    try: () => immutableJson(event) as unknown as OpenMAEvent,
    catch: (cause) =>
      driverError(
        "Claude Agent Connector emitted a non-immutable OpenMAEvent",
        cause,
      ),
  });
};

const validateConnectorCapabilities = (
  value: unknown,
): Effect.Effect<ConnectorCapabilities, AgentDriverError> =>
  Effect.try({
    try: () => {
      if (!isRecord(value))
        throw new TypeError("capabilities must be an object");
      if (
        !["ephemeral", "resumable", "persistent"].includes(
          String(value.sessionPersistence),
        )
      ) {
        throw new TypeError("sessionPersistence is invalid");
      }
      for (const field of [
        "streaming",
        "cancellation",
        "permissions",
        "elicitation",
      ] as const) {
        if (typeof value[field] !== "boolean") {
          throw new TypeError(`${field} must be boolean`);
        }
      }
      for (const field of ["steering", "customTools", "mcp"] as const) {
        if (value[field] !== undefined && typeof value[field] !== "boolean") {
          throw new TypeError(`${field} must be boolean when present`);
        }
      }
      if (value.extensions !== undefined) {
        if (!isRecord(value.extensions)) {
          throw new TypeError("extensions must be a JSON object when present");
        }
        immutableJson(value.extensions);
      }
      return value as unknown as ConnectorCapabilities;
    },
    catch: (cause) =>
      driverError(
        "Claude Agent Connector returned invalid capabilities",
        cause,
      ),
  });

export const makeClaudeAgentDriver = (
  options: ClaudeAgentDriverOptions,
): AgentDriver => {
  const connector = options.connector;
  const projectContent = options.content ?? defaultContent;
  const unavailable = options.isSessionUnavailable ?? (() => false);
  const resumeError = (
    cause: unknown,
  ): AgentDriverError | AgentSessionUnavailableError => {
    try {
      return unavailable(cause)
        ? new AgentSessionUnavailableError({
            message: "Claude Agent Session is unavailable",
            cause,
          })
        : driverError("Could not resume Claude Agent Session", cause);
    } catch (classifierCause) {
      return driverError(
        "Claude Agent Session availability classifier failed",
        classifierCause,
      );
    }
  };

  const capabilities = (): Effect.Effect<AgentCapabilities, AgentDriverError> =>
    Effect.tryPromise({
      try: () => connector.capabilities(),
      catch: (cause) =>
        driverError("Could not read Claude Agent capabilities", cause),
    }).pipe(
      Effect.flatMap(validateConnectorCapabilities),
      Effect.map((value) => ({
        resume: value.sessionPersistence !== "ephemeral",
        cancel: value.cancellation,
        permissions: value.permissions,
        concurrentTurns: false,
      })),
    );

  return {
    id: options.id ?? connector.id,
    capabilities,
    createSession: (input) =>
      Effect.tryPromise({
        try: async () =>
          driverHandleFrom(
            await connector.open({
              sessionId: input.sessionId,
              idempotencyKey: input.idempotencyKey,
              generation: input.generation,
              agentId: options.agentId,
              ...(options.session?.cwd === undefined
                ? {}
                : { cwd: options.session.cwd }),
              ...(options.session?.additionalDirectories === undefined
                ? {}
                : {
                    additionalDirectories:
                      options.session.additionalDirectories,
                  }),
              ...(options.session?.metadata === undefined
                ? {}
                : { metadata: immutableJson(options.session.metadata) }),
            }),
            {
              sessionId: input.sessionId,
              idempotencyKey: input.idempotencyKey,
              generation: input.generation,
            },
          ),
        catch: (cause) =>
          driverError("Could not create Claude Agent Session", cause),
      }),
    resumeSession: (handle) =>
      Effect.tryPromise({
        try: async () => {
          const stored = durableHandleFrom(handle);
          const resumed = await connector.open({
            sessionId: stored.sessionId,
            idempotencyKey: stored.idempotencyKey,
            generation: stored.generation,
            agentId: options.agentId,
            resume: stored.connector,
            ...(options.session?.cwd === undefined
              ? {}
              : { cwd: options.session.cwd }),
            ...(options.session?.additionalDirectories === undefined
              ? {}
              : {
                  additionalDirectories: options.session.additionalDirectories,
                }),
            ...(options.session?.metadata === undefined
              ? {}
              : { metadata: immutableJson(options.session.metadata) }),
          });
          return driverHandleFrom(resumed, stored);
        },
        catch: resumeError,
      }),
    turn: (input) =>
      Stream.unwrap(
        Effect.try({
          try: () => ({
            session: connectorHandleFrom(input.session),
            content: immutableJson(
              projectContent(input.context),
            ) as AgentContent,
          }),
          catch: (cause) =>
            driverError("Could not prepare Claude Agent Turn", cause),
        }).pipe(
          Effect.flatMap(({ session, content }) =>
            Effect.try({
              try: () => {
                const events = connector.execute(session, {
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  afterSequence: input.afterSequence,
                  contextDigest: input.context.digest,
                  content,
                  grants: input.allow,
                });
                if (
                  events === null ||
                  typeof events !== "object" ||
                  typeof events[Symbol.asyncIterator] !== "function"
                ) {
                  throw new TypeError(
                    "Claude Agent Connector execute() must return an AsyncIterable",
                  );
                }
                return events;
              },
              catch: (cause) =>
                driverError("Claude Agent Turn stream failed", cause),
            }).pipe(
              Effect.map((events) =>
                Stream.fromAsyncIterable(events, (cause) =>
                  driverError("Claude Agent Turn stream failed", cause),
                ).pipe(
                  Stream.mapEffect(validateConnectorEvent),
                  Stream.filter(
                    (event) =>
                      event.seq === undefined ||
                      event.seq > input.afterSequence,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    respondToPermission: ({ session, requestId, approved }) =>
      Effect.tryPromise({
        try: () =>
          connector.send(connectorHandleFrom(session), {
            type: "callback.respond",
            callbackId: requestId,
            result: { approved },
          }),
        catch: (cause) =>
          driverError("Could not answer Claude Agent permission", cause),
      }),
    cancel: ({ session, turnId }) =>
      Effect.tryPromise({
        try: () =>
          connector.send(connectorHandleFrom(session), {
            type: "turn.cancel",
            turnId,
          }),
        catch: (cause) =>
          driverError("Could not cancel Claude Agent Turn", cause),
      }),
    closeSession: (session) =>
      Effect.tryPromise({
        try: () => connector.close(connectorHandleFrom(session)),
        catch: (cause) =>
          driverError("Could not close Claude Agent Session", cause),
      }),
  };
};

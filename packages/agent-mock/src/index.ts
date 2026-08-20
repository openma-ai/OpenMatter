import {
  createOpenMAEvent,
  type AgentDriver,
  type OpenMAEvent,
} from "@openmatter/agent";
import { Effect, Stream } from "effect";

export interface MockAgentDriver {
  readonly driver: AgentDriver;
  readonly permissionResponses: () => readonly {
    readonly requestId: string;
    readonly approved: boolean;
  }[];
  readonly cancelledTurns: () => readonly string[];
  readonly createdSessions: () => number;
}

export const makeMockAgentDriver = (options: {
  readonly id: string;
  readonly output: string;
  readonly omitTerminal?: boolean;
  readonly neverComplete?: boolean;
  readonly terminalType?:
    "turn.completed" | "turn.failed" | "turn.cancelled" | "turn.interrupted";
  readonly permissionRequestId?: string;
  readonly resume?: boolean;
}): MockAgentDriver => {
  let nextSession = 1;
  const permissionResponses: Array<{
    readonly requestId: string;
    readonly approved: boolean;
  }> = [];
  const cancelledTurns: string[] = [];
  const sessionsByIdempotencyKey = new Map<string, { readonly id: string }>();

  const driver: AgentDriver = {
    id: options.id,
    capabilities: () =>
      Effect.succeed({
        resume: options.resume ?? true,
        cancel: true,
        permissions: true,
        concurrentTurns: false,
      }),
    createSession: ({ idempotencyKey }) =>
      Effect.sync(() => {
        const existing = sessionsByIdempotencyKey.get(idempotencyKey);
        if (existing !== undefined) return existing;
        const created = { id: `${options.id}-session-${nextSession++}` };
        sessionsByIdempotencyKey.set(idempotencyKey, created);
        return created;
      }),
    resumeSession: (handle) => Effect.succeed(handle),
    turn: (input) => {
      if (options.neverComplete) return Stream.never;
      const timestamp = new Date().toISOString();
      const events: readonly OpenMAEvent[] = [
        ...(options.permissionRequestId === undefined
          ? []
          : [
              createOpenMAEvent({
                event_id: `${input.turnId}:permission`,
                session_id: input.sessionId,
                turn_id: input.turnId,
                seq: 1,
                type: "callback.requested",
                occurred_at: timestamp,
                source: { kind: "harness", harness: options.id },
                data: {
                  callback_id: options.permissionRequestId,
                  fingerprint: `${input.turnId}:${options.permissionRequestId}`,
                  method: "permission.request",
                  category: "permission",
                },
              }),
            ]),
        createOpenMAEvent({
          event_id: `${input.turnId}:output`,
          session_id: input.sessionId,
          turn_id: input.turnId,
          seq: options.permissionRequestId === undefined ? 1 : 2,
          type: "agent.message",
          occurred_at: timestamp,
          source: { kind: "harness", harness: options.id },
          data: { text: options.output },
        }),
        ...(options.omitTerminal
          ? []
          : [
              createOpenMAEvent({
                event_id: `${input.turnId}:terminal`,
                session_id: input.sessionId,
                turn_id: input.turnId,
                seq: options.permissionRequestId === undefined ? 2 : 3,
                type: options.terminalType ?? "turn.completed",
                occurred_at: timestamp,
                source: { kind: "harness", harness: options.id },
                data: {},
              }),
            ]),
      ];
      return Stream.fromIterable(
        events.filter((event) => (event.seq ?? 0) > input.afterSequence),
      );
    },
    respondToPermission: ({ requestId, approved }) =>
      Effect.sync(() => {
        permissionResponses.push({ requestId, approved });
      }),
    cancel: ({ turnId }) =>
      Effect.sync(() => {
        cancelledTurns.push(turnId);
      }),
    closeSession: () => Effect.void,
  };

  return {
    driver,
    permissionResponses: () => [...permissionResponses],
    cancelledTurns: () => [...cancelledTurns],
    createdSessions: () => nextSession - 1,
  };
};

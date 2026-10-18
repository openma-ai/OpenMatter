import type { JsonValue } from "@openma/matter";
import {
  createOpenMAEvent,
  OPERATION_CALL_METHOD,
  type AgentDriver,
  type AgentTurnInput,
  type OpenMAEvent,
} from "@openma/matter/agent";
import { Effect, Stream } from "effect";

export interface MockAgentDriver {
  readonly driver: AgentDriver;
  readonly permissionResponses: () => readonly {
    readonly requestId: string;
    readonly approved: boolean;
  }[];
  readonly callbackResponses: () => readonly {
    readonly callbackId: string;
    readonly result: JsonValue;
  }[];
  readonly turnInputs: () => readonly AgentTurnInput[];
  readonly cancelledTurns: () => readonly string[];
  readonly createdSessions: () => number;
}

/** An operation the mock Agent calls before it answers. */
export interface MockOperationCall {
  readonly callId: string;
  readonly integrationId: string;
  readonly operation: string;
  readonly input: JsonValue;
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
  /** Emitted as operation-call callbacks, in order, before the output. */
  readonly operationCalls?: readonly MockOperationCall[];
  /** Defaults to true when `operationCalls` is set. */
  readonly operations?: boolean;
}): MockAgentDriver => {
  let nextSession = 1;
  const permissionResponses: Array<{
    readonly requestId: string;
    readonly approved: boolean;
  }> = [];
  const cancelledTurns: string[] = [];
  const callbackResponses: Array<{
    readonly callbackId: string;
    readonly result: JsonValue;
  }> = [];
  const turnInputs: AgentTurnInput[] = [];
  const sessionsByIdempotencyKey = new Map<string, { readonly id: string }>();

  const driver: AgentDriver = {
    id: options.id,
    capabilities: () =>
      Effect.succeed({
        resume: options.resume ?? true,
        cancel: true,
        permissions: true,
        concurrentTurns: false,
        operations: options.operations ?? options.operationCalls !== undefined,
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
      turnInputs.push(input);
      if (options.neverComplete) return Stream.never;
      const timestamp = new Date().toISOString();
      let seq = 0;
      const event = (
        suffix: string,
        type: string,
        data: Record<string, unknown>,
      ): OpenMAEvent =>
        createOpenMAEvent({
          event_id: `${input.turnId}:${suffix}`,
          session_id: input.sessionId,
          turn_id: input.turnId,
          seq: ++seq,
          type,
          occurred_at: timestamp,
          source: { kind: "harness", harness: options.id },
          data,
        } as Parameters<typeof createOpenMAEvent>[0]) as OpenMAEvent;
      const events: readonly OpenMAEvent[] = [
        ...(options.permissionRequestId === undefined
          ? []
          : [
              event("permission", "callback.requested", {
                callback_id: options.permissionRequestId,
                fingerprint: `${input.turnId}:${options.permissionRequestId}`,
                method: "permission.request",
                category: "permission",
              }),
            ]),
        ...(options.operationCalls ?? []).map((call) =>
          event(`call:${call.callId}`, "callback.requested", {
            callback_id: call.callId,
            fingerprint: `${input.turnId}:${call.callId}:${JSON.stringify([
              call.integrationId,
              call.operation,
              call.input,
            ])}`,
            method: OPERATION_CALL_METHOD,
            category: "extension",
            params: {
              integrationId: call.integrationId,
              operation: call.operation,
              input: call.input,
            },
          }),
        ),
        event("output", "agent.message", { text: options.output }),
        ...(options.omitTerminal
          ? []
          : [event("terminal", options.terminalType ?? "turn.completed", {})]),
      ];
      return Stream.fromIterable(
        events.filter((item) => (item.seq ?? 0) > input.afterSequence),
      );
    },
    respondToPermission: ({ requestId, approved }) =>
      Effect.sync(() => {
        permissionResponses.push({ requestId, approved });
      }),
    respondToCallback: ({ callbackId, result }) =>
      Effect.sync(() => {
        callbackResponses.push({ callbackId, result });
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
    callbackResponses: () => [...callbackResponses],
    turnInputs: () => [...turnInputs],
    cancelledTurns: () => [...cancelledTurns],
    createdSessions: () => nextSession - 1,
  };
};

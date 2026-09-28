import type { ContextItem, JsonValue } from "@openmatter/core";
import {
  defineLoop,
  type AgentTurnResult,
  type EffectInput,
  type Loop,
  type OpenMatterApplication,
  type WorkContext,
} from "@openmatter/runtime";
import { Effect } from "effect";

export interface LinearAgentSurfaceProjectionInput {
  readonly organizationId: string;
  readonly appUserId: string;
  readonly oauthClientId?: string;
  readonly agentSessionId: string;
  readonly events: AgentTurnResult["events"];
  readonly maxActivities?: number;
  readonly externalUrls?: readonly {
    readonly label: string;
    readonly url: string;
  }[];
}

export interface LinearAgentSurfaceOptions {
  readonly agentId: string;
  readonly initialThought?: string;
  readonly maxActivities?: number;
  readonly context?: (
    work: WorkContext,
  ) =>
    | readonly ContextItem[]
    | Promise<readonly ContextItem[]>
    | Effect.Effect<readonly ContextItem[], unknown>;
  readonly externalUrls?:
    | readonly { readonly label: string; readonly url: string }[]
    | ((input: {
        readonly work: WorkContext;
        readonly turn: AgentTurnResult;
      }) =>
        | readonly { readonly label: string; readonly url: string }[]
        | Promise<readonly { readonly label: string; readonly url: string }[]>
        | Effect.Effect<
            readonly { readonly label: string; readonly url: string }[],
            unknown
          >);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringAt = (
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : undefined;
};

const activityIntent = (
  input: LinearAgentSurfaceProjectionInput,
  eventId: string,
  content: Record<string, JsonValue>,
  ephemeral: boolean,
  modifiers: {
    readonly signal?: "auth" | "select";
    readonly signalMetadata?: Record<string, JsonValue>;
  } = {},
): EffectInput => ({
  integrationId: "linear",
  operation: "agent.activity.create",
  idempotencyKey: `linear:${input.agentSessionId}:openma:${eventId}`,
  input: {
    organizationId: input.organizationId,
    appUserId: input.appUserId,
    ...(input.oauthClientId === undefined
      ? {}
      : { oauthClientId: input.oauthClientId }),
    agentSessionId: input.agentSessionId,
    content,
    ephemeral,
    ...(modifiers.signal === undefined ? {} : { signal: modifiers.signal }),
    ...(modifiers.signalMetadata === undefined
      ? {}
      : { signalMetadata: modifiers.signalMetadata }),
  },
});

const sessionIntent = (
  input: LinearAgentSurfaceProjectionInput,
  eventId: string,
  changes: Record<string, JsonValue>,
): EffectInput => ({
  integrationId: "linear",
  operation: "agent.session.update",
  idempotencyKey: `linear:${input.agentSessionId}:openma:${eventId}`,
  input: {
    organizationId: input.organizationId,
    appUserId: input.appUserId,
    ...(input.oauthClientId === undefined
      ? {}
      : { oauthClientId: input.oauthClientId }),
    agentSessionId: input.agentSessionId,
    ...changes,
  },
});

const linearPlanStatus = (status: unknown): string =>
  status === "in_progress" ? "inProgress" : String(status ?? "pending");

const planFrom = (data: Record<string, unknown>): JsonValue | undefined => {
  if (!Array.isArray(data.entries)) return undefined;
  const steps = data.entries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.content !== "string") return [];
    return [
      {
        ...(typeof entry.id === "string" ? { id: entry.id } : {}),
        label: entry.content,
        status: linearPlanStatus(entry.status),
      },
    ];
  });
  return { steps };
};

const elicitationBody = (data: Record<string, unknown>): string => {
  const params = isRecord(data.params) ? data.params : undefined;
  return (
    stringAt(params, "body") ??
    stringAt(params, "prompt") ??
    stringAt(params, "title") ??
    "Agent needs additional input"
  );
};

const elicitationModifiers = (
  data: Record<string, unknown>,
): {
  readonly signal?: "auth" | "select";
  readonly signalMetadata?: Record<string, JsonValue>;
} => {
  const params = isRecord(data.params) ? data.params : undefined;
  const signal = stringAt(params, "signal");
  const metadata = isRecord(params?.signalMetadata)
    ? params.signalMetadata
    : undefined;
  if (signal === "auth" && metadata !== undefined) {
    const url = stringAt(metadata, "url");
    if (url === undefined) return {};
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return {};
      }
    } catch {
      return {};
    }
    return {
      signal: "auth",
      signalMetadata: {
        url,
        ...(stringAt(metadata, "userId") === undefined
          ? {}
          : { userId: stringAt(metadata, "userId")! }),
        ...(stringAt(metadata, "providerName") === undefined
          ? {}
          : { providerName: stringAt(metadata, "providerName")! }),
      },
    };
  }
  if (
    signal === "select" &&
    metadata !== undefined &&
    Array.isArray(metadata.options)
  ) {
    const options = metadata.options.slice(0, 20).flatMap((option) => {
      if (!isRecord(option)) return [];
      const value = stringAt(option, "value");
      const label = stringAt(option, "label");
      if (value === undefined) return [];
      return [{ ...(label === undefined ? {} : { label }), value }];
    });
    if (options.length === 0) return {};
    return { signal: "select", signalMetadata: { options } };
  }
  return {};
};

/**
 * Explicit GUI projection for Linear's Agent Surface.
 *
 * OpenMA events stay the durable runtime facts. This function emits only the
 * finite Linear operations that an application may authorize. Raw tool
 * inputs/outputs and private thinking text are deliberately never copied.
 */
export const projectLinearAgentSurface = (
  input: LinearAgentSurfaceProjectionInput,
): readonly EffectInput[] => {
  const projected: EffectInput[] = [];
  const activeTools = new Map<
    string,
    { readonly eventId: string; readonly data: Record<string, unknown> }
  >();
  let projectedThinking = false;
  let lastMessage:
    { readonly eventId: string; readonly text: string } | undefined;
  const messageChunks = new Map<string, { eventId: string; text: string }>();
  let lastChunkMessageId: string | undefined;

  for (const event of input.events) {
    const data = isRecord(event.data) ? event.data : {};
    switch (event.type) {
      case "agent.thinking":
        if (!projectedThinking) {
          projected.push(
            activityIntent(
              input,
              event.event_id,
              { type: "thought", body: "Working…" },
              true,
            ),
          );
          projectedThinking = true;
        }
        break;
      case "tool.started": {
        const toolCallId = stringAt(data, "tool_call_id");
        if (toolCallId !== undefined) {
          activeTools.set(toolCallId, { eventId: event.event_id, data });
        }
        break;
      }
      case "tool.completed":
      case "tool.failed":
      case "tool.cancelled": {
        const toolCallId = stringAt(data, "tool_call_id");
        const started =
          toolCallId === undefined ? undefined : activeTools.get(toolCallId);
        const title =
          stringAt(data, "title") ??
          stringAt(started?.data, "title") ??
          "Agent action";
        const toolName =
          stringAt(data, "tool_name") ??
          stringAt(started?.data, "tool_name") ??
          stringAt(data, "kind") ??
          stringAt(started?.data, "kind") ??
          "tool";
        const result =
          event.type === "tool.completed"
            ? "Completed"
            : event.type === "tool.cancelled"
              ? "Cancelled"
              : "Failed";
        projected.push(
          activityIntent(
            input,
            event.event_id,
            {
              type: "action",
              action: title,
              parameter: toolName,
              result,
            },
            true,
          ),
        );
        if (toolCallId !== undefined) activeTools.delete(toolCallId);
        break;
      }
      case "callback.requested":
        if (data.category === "elicitation") {
          projected.push(
            activityIntent(
              input,
              event.event_id,
              { type: "elicitation", body: elicitationBody(data) },
              false,
              elicitationModifiers(data),
            ),
          );
        }
        break;
      case "plan.updated": {
        const plan = planFrom(data);
        if (plan !== undefined) {
          projected.push(sessionIntent(input, event.event_id, { plan }));
        }
        break;
      }
      case "plan.removed":
        projected.push(
          sessionIntent(input, event.event_id, { plan: { steps: [] } }),
        );
        break;
      case "agent.message": {
        const text = stringAt(data, "text");
        if (text !== undefined) {
          lastMessage = { eventId: event.event_id, text };
        }
        break;
      }
      case "agent.message_chunk": {
        const text = stringAt(data, "text");
        if (text === undefined) break;
        const messageId = stringAt(data, "message_id") ?? "default";
        const accumulated = messageChunks.get(messageId)?.text ?? "";
        messageChunks.set(messageId, {
          eventId: event.event_id,
          text: `${accumulated}${text}`,
        });
        lastChunkMessageId = messageId;
        break;
      }
      case "turn.failed":
      case "turn.cancelled":
      case "turn.interrupted": {
        const body =
          event.type === "turn.cancelled"
            ? "Agent work was cancelled"
            : event.type === "turn.interrupted"
              ? "Agent work was interrupted"
              : "Agent work failed";
        projected.push(
          activityIntent(input, event.event_id, { type: "error", body }, false),
        );
        break;
      }
    }
  }

  if (lastMessage === undefined && lastChunkMessageId !== undefined) {
    lastMessage = messageChunks.get(lastChunkMessageId);
  }
  if (lastMessage !== undefined) {
    projected.push(
      activityIntent(
        input,
        lastMessage.eventId,
        { type: "response", body: lastMessage.text },
        false,
      ),
    );
  }

  if (input.externalUrls !== undefined && input.externalUrls.length > 0) {
    const lastEvent = input.events.at(-1);
    projected.push(
      sessionIntent(input, lastEvent?.event_id ?? "external-urls", {
        addedExternalUrls: input.externalUrls,
      }),
    );
  }

  const maximum = Math.max(1, Math.floor(input.maxActivities ?? 12));
  const activityIndexes = projected.flatMap((intent, index) =>
    intent.operation === "agent.activity.create" ? [index] : [],
  );
  if (activityIndexes.length <= maximum) return projected;

  const keptActivities = new Set([
    ...activityIndexes.slice(0, maximum - 1),
    activityIndexes.at(-1) as number,
  ]);
  return projected.filter(
    (intent, index) =>
      intent.operation !== "agent.activity.create" || keptActivities.has(index),
  );
};

const loadContext = (
  loader: NonNullable<LinearAgentSurfaceOptions["context"]>,
  work: WorkContext,
): Effect.Effect<readonly ContextItem[], unknown> =>
  Effect.suspend(() => {
    try {
      const result = loader(work);
      if (Effect.isEffect(result)) {
        return result as Effect.Effect<readonly ContextItem[], unknown>;
      }
      if (result instanceof Promise) {
        return Effect.tryPromise({
          try: () => result,
          catch: (cause) => cause,
        });
      }
      return Effect.succeed(result);
    } catch (cause) {
      return Effect.fail(cause);
    }
  });

const loadExternalUrls = (
  source: NonNullable<LinearAgentSurfaceOptions["externalUrls"]>,
  input: { readonly work: WorkContext; readonly turn: AgentTurnResult },
): Effect.Effect<
  readonly { readonly label: string; readonly url: string }[],
  unknown
> =>
  Effect.suspend(() => {
    try {
      if (typeof source !== "function") return Effect.succeed(source);
      const result = source(input);
      if (Effect.isEffect(result)) {
        return result as Effect.Effect<
          readonly { readonly label: string; readonly url: string }[],
          unknown
        >;
      }
      if (result instanceof Promise) {
        return Effect.tryPromise({
          try: () => result,
          catch: (cause) => cause,
        });
      }
      return Effect.succeed(result);
    } catch (cause) {
      return Effect.fail(cause);
    }
  });

const surfaceBinding = (work: WorkContext) => {
  if (!isRecord(work.event.payload)) {
    throw new Error("Linear Agent Surface requires an event payload");
  }
  const organizationId = work.event.source.authority;
  const agentSessionId = stringAt(work.event.payload, "agentSessionId");
  const appUserId = stringAt(work.event.payload, "appUserId");
  const oauthClientId = stringAt(work.event.payload, "oauthClientId");
  if (agentSessionId === undefined || appUserId === undefined) {
    throw new Error(
      "Linear Agent Surface requires agentSessionId and appUserId",
    );
  }
  const scopeId = `linear:${organizationId}:app:${appUserId}`;
  return {
    organizationId,
    agentSessionId,
    appUserId,
    ...(oauthClientId === undefined ? {} : { oauthClientId }),
    scopeId,
    workThreadId: `linear:${organizationId}:agent-session:${agentSessionId}`,
  };
};

const installLinearAgentSurface = (
  app: OpenMatterApplication,
  options: LinearAgentSurfaceOptions,
): OpenMatterApplication => {
  const additionalContext = (work: WorkContext) =>
    options.context === undefined
      ? Effect.succeed([] as readonly ContextItem[])
      : loadContext(options.context, work);

  app.on("linear.agent-session.accepted", (work) =>
    Effect.gen(function* () {
      const binding = surfaceBinding(work);
      const extra = yield* additionalContext(work);
      const context = yield* work.context.project({
        scopeId: binding.scopeId,
        workThreadId: binding.workThreadId,
        items: [work.context.event(), ...extra],
        grants: ["linear.agent.activity.create"],
      });
      const accepted = yield* work.effect(context, {
        integrationId: "linear",
        operation: "agent.activity.create",
        idempotencyKey: `linear:${binding.agentSessionId}:surface:accepted`,
        input: {
          organizationId: binding.organizationId,
          appUserId: binding.appUserId,
          ...(binding.oauthClientId === undefined
            ? {}
            : { oauthClientId: binding.oauthClientId }),
          agentSessionId: binding.agentSessionId,
          content: {
            type: "thought",
            body: options.initialThought ?? "Starting work…",
          },
          ephemeral: true,
        },
      });
      return work.react.effects([accepted]);
    }),
  );

  const run = (work: WorkContext) =>
    Effect.gen(function* () {
      const binding = surfaceBinding(work);
      const extra = yield* additionalContext(work);
      const context = yield* work.context.project({
        scopeId: binding.scopeId,
        workThreadId: binding.workThreadId,
        items: [work.context.event(), ...extra],
        grants: ["linear.agent.activity.create", "linear.agent.session.update"],
      });
      const turn = yield* work
        .agent(options.agentId)
        .session({
          scopeId: binding.scopeId,
          workThreadId: binding.workThreadId,
          authority: binding.organizationId,
          privacyPartition: binding.scopeId,
        })
        .turn({ context, allow: context.grants });
      const urls =
        options.externalUrls === undefined
          ? undefined
          : yield* loadExternalUrls(options.externalUrls, { work, turn });
      const intents = projectLinearAgentSurface({
        organizationId: binding.organizationId,
        appUserId: binding.appUserId,
        ...(binding.oauthClientId === undefined
          ? {}
          : { oauthClientId: binding.oauthClientId }),
        agentSessionId: binding.agentSessionId,
        events: turn.events,
        ...(options.maxActivities === undefined
          ? {}
          : { maxActivities: options.maxActivities }),
        ...(urls === undefined ? {} : { externalUrls: urls }),
      });
      const effects = yield* Effect.forEach(intents, (intent) =>
        work.effect(context, intent),
      );
      return work.react.effects(effects);
    });

  app.on("linear.agent-session.created", run);
  app.on("linear.agent-session.prompted", run);
  app.on("linear.agent-session.stop-requested", (work) =>
    Effect.gen(function* () {
      const binding = surfaceBinding(work);
      const cancellation = yield* work
        .agent(options.agentId)
        .session({
          scopeId: binding.scopeId,
          workThreadId: binding.workThreadId,
          authority: binding.organizationId,
          privacyPartition: binding.scopeId,
        })
        .cancel();
      const context = yield* work.context.project({
        scopeId: binding.scopeId,
        workThreadId: binding.workThreadId,
        items: [work.context.event()],
        grants: ["linear.agent.activity.create"],
      });
      const response = yield* work.effect(context, {
        integrationId: "linear",
        operation: "agent.activity.create",
        idempotencyKey: `linear:${binding.agentSessionId}:surface:stop:${work.event.id}`,
        input: {
          organizationId: binding.organizationId,
          appUserId: binding.appUserId,
          ...(binding.oauthClientId === undefined
            ? {}
            : { oauthClientId: binding.oauthClientId }),
          agentSessionId: binding.agentSessionId,
          content: {
            type: "response",
            body:
              cancellation.status === "requested"
                ? "Stopping work…"
                : "There is no active work to stop.",
          },
          ephemeral: false,
        },
      });
      return work.react.effects([response]);
    }),
  );
  return app;
};

export const linearAgentSurface = (options: LinearAgentSurfaceOptions): Loop =>
  defineLoop(
    {
      id: "linear-agent-surface",
      version: "0.1.0",
      description:
        "Project one private Agent runtime into Linear's Agent Session GUI",
      spec: {
        integration: "linear",
        sources: [
          "linear.agent-session.accepted",
          "linear.agent-session.created",
          "linear.agent-session.prompted",
          "linear.agent-session.stop-requested",
        ],
        association: {
          scope: "linear.organization-app-identity",
          workThread: "linear.agent-session",
        },
        agent: { id: options.agentId, session: "per-work-thread" },
        surfaceProjection: "explicit-de-sensitive-bounded",
        reaction: "terminal-per-event",
      },
    },
    (app) => installLinearAgentSurface(app, options),
  );

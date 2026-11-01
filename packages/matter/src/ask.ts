import { Schema } from "effect";
import { JsonValueSchema, type JsonValue } from "./json.js";
import type {
  ConversationEntry,
  ConversationObservation,
  ConversationSender,
  WorkEvent,
} from "./index.js";

/**
 * How an outbound reply says a human answer is expected. A host may put it on
 * the reply input itself (`expectReply: true` / `ask: true`) or under the
 * opaque `_meta` object. OpenMatter only reads these markers; the host owns any
 * other meaning in `_meta`.
 */
export interface AskMarker {
  /** The marker object, preserved on the receipt as opaque host metadata. */
  readonly _meta?: JsonValue;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `true` is the ordinary flag; an object is an explicit ask descriptor. */
const isAskFlag = (value: unknown): boolean =>
  value === true ||
  (isRecord(value) &&
    value.enabled !== false &&
    value.expectReply !== false &&
    value.ask !== false);

const markerFrom = (value: unknown): AskMarker | undefined => {
  if (!isRecord(value)) return undefined;
  if (isAskFlag(value.expectReply) || isAskFlag(value.ask)) {
    return { _meta: value as JsonValue };
  }
  const meta = value._meta;
  if (isRecord(meta) && (isAskFlag(meta.expectReply) || isAskFlag(meta.ask))) {
    return { _meta: meta as JsonValue };
  }
  return undefined;
};

/**
 * Finds an ask marker in any of the places a call can carry one: the callback
 * params, the Agent's raw input, or the input an integration bound. The first
 * match wins, so a bound input can add a marker but cannot remove one.
 */
export const findAskMarker = (
  ...values: readonly unknown[]
): AskMarker | undefined => {
  for (const value of values) {
    const marker = markerFrom(value);
    if (marker !== undefined) return marker;
  }
  return undefined;
};

export const AskStatusSchema = Schema.Literal("open", "answered", "cancelled");

export type AskStatus = typeof AskStatusSchema.Type;

/** The human message that answered an ask. */
export const AskAnswerSchema = Schema.Struct({
  eventId: Schema.String,
  revision: Schema.optional(Schema.Number),
  messageId: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  sender: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.Literal("human", "app"),
    }),
  ),
  answeredAt: Schema.String,
}).annotations({ identifier: "AskAnswer" });

export type AskAnswer = typeof AskAnswerSchema.Type;

/**
 * One delivered reply that expects an answer, bound to the outbox identity of
 * that delivery (`outboxId`), the Turn that sent it, and the conversation
 * revision the sender had seen. A later human message in the same conversation
 * and thread may answer the earliest still-open ask.
 */
export const AskReceiptSchema = Schema.Struct({
  schemaVersion: Schema.String,
  conversationKey: Schema.String,
  /** The conversation id part of `conversationKey`, when known. */
  conversationId: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  /** The delivery identity, `${turnId}:call:${callId}`, as for WorkEffect. */
  outboxId: Schema.String,
  triggerEventId: Schema.String,
  turnId: Schema.String,
  callId: Schema.String,
  seenRevision: Schema.Number,
  status: AskStatusSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  answer: Schema.optional(AskAnswerSchema),
  /** Host-defined ask metadata, never interpreted by OpenMatter. */
  _meta: Schema.optional(JsonValueSchema),
}).annotations({ identifier: "AskReceipt" });

export type AskReceipt = typeof AskReceiptSchema.Type;

/** What a host may attach to an answer WorkEvent under `ASK_ANSWER_EXTENSION`. */
export const AskAnswerBindingSchema = Schema.Struct({
  schemaVersion: Schema.String,
  ask: AskReceiptSchema,
  answer: AskAnswerSchema,
}).annotations({ identifier: "AskAnswerBinding" });

export type AskAnswerBinding = typeof AskAnswerBindingSchema.Type;

/** Convention for the answer binding in `WorkEvent.extensions`. */
export const ASK_ANSWER_EXTENSION = "openma.ask";

/** The conversation id in a `[provider, authority, conversationId]` key. */
export const conversationIdFromKey = (
  conversationKey: string,
): string | undefined => {
  try {
    const parts: unknown = JSON.parse(conversationKey);
    return Array.isArray(parts) && typeof parts[2] === "string"
      ? parts[2]
      : undefined;
  } catch {
    return undefined;
  }
};

/** A human message that matches an open ask, before it is given a timestamp. */
export interface AskMatch {
  readonly ask: AskReceipt;
  readonly answer: Omit<AskAnswer, "answeredAt"> & {
    readonly sender?: ConversationSender;
  };
}

const entryRevision = (
  value: ConversationEntry | ConversationObservation,
): number | undefined =>
  "revision" in value && typeof value.revision === "number"
    ? value.revision
    : undefined;

const entryEventId = (
  value: ConversationEntry | ConversationObservation,
): string | undefined =>
  "eventId" in value && typeof value.eventId === "string"
    ? value.eventId
    : undefined;

/**
 * Pure match of one conversation observation/entry against open asks. It
 * matches the same conversation and thread, a human sender, and a non-recall
 * entry newer than what the ask had seen. The earliest still-open ask wins, so
 * a burst of messages cannot answer two asks at once.
 *
 * A `ConversationObservation` has no revision or event id; pass the recorded
 * `ConversationEntry` when those are needed to rule out an old message.
 */
export const matchOpenAsk = (
  observation: ConversationObservation | ConversationEntry,
  openAsks: readonly AskReceipt[],
): AskMatch | undefined => {
  if (observation.kind === "recall") return undefined;
  const sender = observation.sender;
  if (sender?.kind !== "human") return undefined;

  const conversationKey =
    "conversationKey" in observation ? observation.conversationKey : undefined;
  const conversationId =
    "conversationId" in observation
      ? observation.conversationId
      : conversationIdFromKey(conversationKey ?? "");
  const revision = entryRevision(observation);
  const eventId = entryEventId(observation);

  const ask = [...openAsks]
    .filter((candidate) => {
      if (candidate.status !== "open") return false;
      if (conversationKey !== undefined) {
        if (candidate.conversationKey !== conversationKey) return false;
      } else if (conversationId === undefined) {
        return false;
      } else if (
        candidate.conversationId !== conversationId &&
        conversationIdFromKey(candidate.conversationKey) !== conversationId
      ) {
        return false;
      }
      if (candidate.threadId !== observation.threadId) return false;
      if (eventId !== undefined && eventId === candidate.triggerEventId) {
        return false;
      }
      if (
        revision !== undefined &&
        candidate.seenRevision > 0 &&
        revision <= candidate.seenRevision
      ) {
        return false;
      }
      return true;
    })
    .sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.outboxId.localeCompare(right.outboxId)
        : left.createdAt.localeCompare(right.createdAt),
    )[0];

  if (ask === undefined) return undefined;
  return {
    ask,
    answer: {
      ...(eventId === undefined ? {} : { eventId }),
      ...(revision === undefined ? {} : { revision }),
      ...(observation.messageId === undefined
        ? {}
        : { messageId: observation.messageId }),
      ...(observation.threadId === undefined
        ? {}
        : { threadId: observation.threadId }),
      ...(sender === undefined ? {} : { sender }),
    } as AskMatch["answer"],
  };
};

/** Attach the answer binding to a WorkEvent without interpreting host fields. */
export const withAskAnswer = (
  event: WorkEvent,
  match: AskMatch,
  answeredAt: string,
): WorkEvent => {
  const answer: AskAnswer = {
    ...match.answer,
    answeredAt,
  };
  const binding: AskAnswerBinding = {
    schemaVersion: "0.1",
    ask: match.ask,
    answer,
  };
  return {
    ...event,
    extensions: {
      ...event.extensions,
      [ASK_ANSWER_EXTENSION]: binding as unknown as JsonValue,
    },
  };
};

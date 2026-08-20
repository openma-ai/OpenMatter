import { Schema } from "effect";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const isJsonValue = (
  input: unknown,
  seen: WeakSet<object> = new WeakSet(),
): input is JsonValue => {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean"
  ) {
    return true;
  }
  if (typeof input === "number") return Number.isFinite(input);
  if (typeof input !== "object" || seen.has(input)) return false;

  seen.add(input);
  if (Array.isArray(input)) {
    const valid = input.every((value) => isJsonValue(value, seen));
    seen.delete(input);
    return valid;
  }

  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const valid = Object.values(input).every((value) => isJsonValue(value, seen));
  seen.delete(input);
  return valid;
};

export const JsonValueSchema = Schema.declare<JsonValue>(isJsonValue, {
  identifier: "JsonValue",
  description:
    "Portable JSON data: finite numbers, primitives, arrays and plain objects",
});

export const SourceAnchorSchema = Schema.Struct({
  provider: Schema.String,
  authority: Schema.String,
  conversationId: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  messageId: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
}).annotations({ identifier: "SourceAnchor" });

export type SourceAnchor = typeof SourceAnchorSchema.Type;

export const WorkEventSchema = Schema.Struct({
  schemaVersion: Schema.String,
  id: Schema.String,
  type: Schema.String,
  occurredAt: Schema.String,
  receivedAt: Schema.String,
  idempotencyKey: Schema.String,
  source: SourceAnchorSchema,
  payload: Schema.optional(JsonValueSchema),
  raw: Schema.optional(JsonValueSchema),
  extensions: Schema.optional(
    Schema.Record({ key: Schema.String, value: JsonValueSchema }),
  ),
}).annotations({ identifier: "WorkEvent" });

export type WorkEvent = typeof WorkEventSchema.Type;

export const WorkEffectSchema = Schema.Struct({
  schemaVersion: Schema.String,
  id: Schema.String,
  eventId: Schema.String,
  integrationId: Schema.String,
  operation: Schema.String,
  idempotencyKey: Schema.String,
  input: JsonValueSchema,
}).annotations({ identifier: "WorkEffect" });

export type WorkEffect = typeof WorkEffectSchema.Type;

export const ContextProvenanceSchema = Schema.Struct({
  sourceType: Schema.String,
  sourceId: Schema.String,
  integrationId: Schema.optional(Schema.String),
  uri: Schema.optional(Schema.String),
}).annotations({ identifier: "ContextProvenance" });

export type ContextProvenance = typeof ContextProvenanceSchema.Type;

export const ContextItemSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  value: JsonValueSchema,
  provenance: Schema.Array(ContextProvenanceSchema),
}).annotations({ identifier: "ContextItem" });

export type ContextItem = typeof ContextItemSchema.Type;

export const ContextProjectionSchema = Schema.Struct({
  schemaVersion: Schema.String,
  id: Schema.String,
  scopeId: Schema.String,
  workThreadId: Schema.String,
  triggerEventId: Schema.String,
  items: Schema.Array(ContextItemSchema),
  grants: Schema.Array(Schema.String),
  digest: Schema.String,
  createdAt: Schema.String,
}).annotations({ identifier: "ContextProjection" });

export type ContextProjection = typeof ContextProjectionSchema.Type;

export const ReactionSchema = Schema.Struct({
  schemaVersion: Schema.String,
  id: Schema.String,
  eventId: Schema.String,
  status: Schema.Literal("completed", "failed", "cancelled"),
  effects: Schema.Array(WorkEffectSchema),
  reason: Schema.optional(Schema.String),
  createdAt: Schema.String,
}).annotations({ identifier: "Reaction" });

export type Reaction = typeof ReactionSchema.Type;

export const EffectDeliveryReceiptSchema = Schema.Struct({
  effectId: Schema.String,
  integrationId: Schema.String,
  operation: Schema.String,
  status: Schema.Literal("delivered", "retryable-failed", "terminal-failed"),
  attempt: Schema.Number,
  attemptedAt: Schema.String,
  nextRetryAt: Schema.optional(Schema.String),
  providerReceipt: Schema.optional(JsonValueSchema),
  error: Schema.optional(Schema.String),
}).annotations({ identifier: "EffectDeliveryReceipt" });

export type EffectDeliveryReceipt = typeof EffectDeliveryReceiptSchema.Type;

export const ReactionReceiptSchema = Schema.Struct({
  reaction: ReactionSchema,
  deliveries: Schema.Array(EffectDeliveryReceiptSchema),
  duplicate: Schema.Boolean,
}).annotations({ identifier: "ReactionReceipt" });

export type ReactionReceipt = typeof ReactionReceiptSchema.Type;

export const AgentSessionSchema = Schema.Struct({
  id: Schema.String,
  bindingKey: Schema.String,
  agentId: Schema.String,
  authority: Schema.String,
  scopeId: Schema.String,
  workThreadId: Schema.String,
  privacyPartition: Schema.String,
  driverId: Schema.String,
  externalHandle: Schema.optional(JsonValueSchema),
  generation: Schema.Number,
  state: Schema.Literal("creating", "open", "interrupted", "closed", "expired"),
  createdAt: Schema.String,
  lastUsedAt: Schema.String,
}).annotations({ identifier: "AgentSession" });

export type AgentSession = typeof AgentSessionSchema.Type;

export const TurnSchema = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  triggerEventId: Schema.String,
  contextProjectionId: Schema.String,
  contextDigest: Schema.String,
  allow: Schema.Array(Schema.String),
  state: Schema.Literal(
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
  ),
  createdAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
}).annotations({ identifier: "Turn" });

export type Turn = typeof TurnSchema.Type;

export const PermissionDecisionSchema = Schema.Struct({
  turnId: Schema.String,
  requestId: Schema.String,
  requestFingerprint: Schema.String,
  approved: Schema.Boolean,
  decidedAt: Schema.String,
}).annotations({ identifier: "PermissionDecision" });

export type PermissionDecision = typeof PermissionDecisionSchema.Type;

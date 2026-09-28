import { Schema } from "effect";
//#region src/index.d.ts
type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | {
  readonly [key: string]: JsonValue;
};
declare const JsonValueSchema: Schema.declare<JsonValue, JsonValue, readonly [], never>;
declare const SourceAnchorSchema: Schema.Struct<{
  provider: typeof Schema.String;
  authority: typeof Schema.String;
  conversationId: Schema.optional<typeof Schema.String>;
  threadId: Schema.optional<typeof Schema.String>;
  messageId: Schema.optional<typeof Schema.String>;
  uri: Schema.optional<typeof Schema.String>;
}>;
type SourceAnchor = typeof SourceAnchorSchema.Type;
declare const WorkEventSchema: Schema.Struct<{
  schemaVersion: typeof Schema.String;
  id: typeof Schema.String;
  type: typeof Schema.String;
  occurredAt: typeof Schema.String;
  receivedAt: typeof Schema.String;
  idempotencyKey: typeof Schema.String;
  source: Schema.Struct<{
    provider: typeof Schema.String;
    authority: typeof Schema.String;
    conversationId: Schema.optional<typeof Schema.String>;
    threadId: Schema.optional<typeof Schema.String>;
    messageId: Schema.optional<typeof Schema.String>;
    uri: Schema.optional<typeof Schema.String>;
  }>;
  payload: Schema.optional<Schema.declare<JsonValue, JsonValue, readonly [], never>>;
  raw: Schema.optional<Schema.declare<JsonValue, JsonValue, readonly [], never>>;
  extensions: Schema.optional<Schema.Record$<typeof Schema.String, Schema.declare<JsonValue, JsonValue, readonly [], never>>>;
}>;
type WorkEvent = typeof WorkEventSchema.Type;
declare const WorkEffectSchema: Schema.Struct<{
  schemaVersion: typeof Schema.String;
  id: typeof Schema.String;
  eventId: typeof Schema.String;
  integrationId: typeof Schema.String;
  operation: typeof Schema.String;
  idempotencyKey: typeof Schema.String;
  input: Schema.declare<JsonValue, JsonValue, readonly [], never>;
}>;
type WorkEffect = typeof WorkEffectSchema.Type;
declare const ContextProvenanceSchema: Schema.Struct<{
  sourceType: typeof Schema.String;
  sourceId: typeof Schema.String;
  integrationId: Schema.optional<typeof Schema.String>;
  uri: Schema.optional<typeof Schema.String>;
}>;
type ContextProvenance = typeof ContextProvenanceSchema.Type;
declare const ContextItemSchema: Schema.Struct<{
  id: typeof Schema.String;
  kind: typeof Schema.String;
  value: Schema.declare<JsonValue, JsonValue, readonly [], never>;
  provenance: Schema.Array$<Schema.Struct<{
    sourceType: typeof Schema.String;
    sourceId: typeof Schema.String;
    integrationId: Schema.optional<typeof Schema.String>;
    uri: Schema.optional<typeof Schema.String>;
  }>>;
}>;
type ContextItem = typeof ContextItemSchema.Type;
declare const ContextProjectionSchema: Schema.Struct<{
  schemaVersion: typeof Schema.String;
  id: typeof Schema.String;
  scopeId: typeof Schema.String;
  workThreadId: typeof Schema.String;
  triggerEventId: typeof Schema.String;
  items: Schema.Array$<Schema.Struct<{
    id: typeof Schema.String;
    kind: typeof Schema.String;
    value: Schema.declare<JsonValue, JsonValue, readonly [], never>;
    provenance: Schema.Array$<Schema.Struct<{
      sourceType: typeof Schema.String;
      sourceId: typeof Schema.String;
      integrationId: Schema.optional<typeof Schema.String>;
      uri: Schema.optional<typeof Schema.String>;
    }>>;
  }>>;
  grants: Schema.Array$<typeof Schema.String>;
  digest: typeof Schema.String;
  createdAt: typeof Schema.String;
}>;
type ContextProjection = typeof ContextProjectionSchema.Type;
declare const ReactionSchema: Schema.Struct<{
  schemaVersion: typeof Schema.String;
  id: typeof Schema.String;
  eventId: typeof Schema.String;
  status: Schema.Literal<["completed", "failed", "cancelled"]>;
  effects: Schema.Array$<Schema.Struct<{
    schemaVersion: typeof Schema.String;
    id: typeof Schema.String;
    eventId: typeof Schema.String;
    integrationId: typeof Schema.String;
    operation: typeof Schema.String;
    idempotencyKey: typeof Schema.String;
    input: Schema.declare<JsonValue, JsonValue, readonly [], never>;
  }>>;
  reason: Schema.optional<typeof Schema.String>;
  createdAt: typeof Schema.String;
}>;
type Reaction = typeof ReactionSchema.Type;
declare const EffectDeliveryReceiptSchema: Schema.Struct<{
  effectId: typeof Schema.String;
  integrationId: typeof Schema.String;
  operation: typeof Schema.String;
  status: Schema.Literal<["delivered", "retryable-failed", "terminal-failed"]>;
  attempt: typeof Schema.Number;
  attemptedAt: typeof Schema.String;
  nextRetryAt: Schema.optional<typeof Schema.String>;
  providerReceipt: Schema.optional<Schema.declare<JsonValue, JsonValue, readonly [], never>>;
  error: Schema.optional<typeof Schema.String>;
}>;
type EffectDeliveryReceipt = typeof EffectDeliveryReceiptSchema.Type;
declare const ReactionReceiptSchema: Schema.Struct<{
  reaction: Schema.Struct<{
    schemaVersion: typeof Schema.String;
    id: typeof Schema.String;
    eventId: typeof Schema.String;
    status: Schema.Literal<["completed", "failed", "cancelled"]>;
    effects: Schema.Array$<Schema.Struct<{
      schemaVersion: typeof Schema.String;
      id: typeof Schema.String;
      eventId: typeof Schema.String;
      integrationId: typeof Schema.String;
      operation: typeof Schema.String;
      idempotencyKey: typeof Schema.String;
      input: Schema.declare<JsonValue, JsonValue, readonly [], never>;
    }>>;
    reason: Schema.optional<typeof Schema.String>;
    createdAt: typeof Schema.String;
  }>;
  deliveries: Schema.Array$<Schema.Struct<{
    effectId: typeof Schema.String;
    integrationId: typeof Schema.String;
    operation: typeof Schema.String;
    status: Schema.Literal<["delivered", "retryable-failed", "terminal-failed"]>;
    attempt: typeof Schema.Number;
    attemptedAt: typeof Schema.String;
    nextRetryAt: Schema.optional<typeof Schema.String>;
    providerReceipt: Schema.optional<Schema.declare<JsonValue, JsonValue, readonly [], never>>;
    error: Schema.optional<typeof Schema.String>;
  }>>;
  duplicate: typeof Schema.Boolean;
}>;
type ReactionReceipt = typeof ReactionReceiptSchema.Type;
declare const AgentSessionSchema: Schema.Struct<{
  id: typeof Schema.String;
  bindingKey: typeof Schema.String;
  agentId: typeof Schema.String;
  authority: typeof Schema.String;
  scopeId: typeof Schema.String;
  workThreadId: typeof Schema.String;
  privacyPartition: typeof Schema.String;
  driverId: typeof Schema.String;
  externalHandle: Schema.optional<Schema.declare<JsonValue, JsonValue, readonly [], never>>;
  generation: typeof Schema.Number;
  state: Schema.Literal<["creating", "open", "interrupted", "closed", "expired"]>;
  createdAt: typeof Schema.String;
  lastUsedAt: typeof Schema.String;
}>;
type AgentSession = typeof AgentSessionSchema.Type;
declare const ThreadGoalStatusSchema: Schema.Literal<["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"]>;
type ThreadGoalStatus = typeof ThreadGoalStatusSchema.Type;
/** A single current objective for a WorkThread, independent of its Sessions. */
declare const ThreadGoalSchema: Schema.Struct<{
  id: typeof Schema.String;
  scopeId: typeof Schema.String;
  workThreadId: typeof Schema.String;
  objective: typeof Schema.String;
  status: Schema.Literal<["active", "paused", "blocked", "usage_limited", "budget_limited", "complete"]>;
  tokenBudget: Schema.optional<typeof Schema.Number>;
  tokensUsed: typeof Schema.Number;
  timeUsedSeconds: typeof Schema.Number;
  createdAt: typeof Schema.String;
  updatedAt: typeof Schema.String;
  revision: typeof Schema.Number;
  reason: Schema.optional<typeof Schema.String>;
}>;
type ThreadGoal = typeof ThreadGoalSchema.Type;
declare const TurnSchema: Schema.Struct<{
  id: typeof Schema.String;
  sessionId: typeof Schema.String;
  triggerEventId: typeof Schema.String;
  contextProjectionId: typeof Schema.String;
  contextDigest: typeof Schema.String;
  allow: Schema.Array$<typeof Schema.String>;
  state: Schema.Literal<["queued", "running", "completed", "failed", "cancelled"]>;
  createdAt: typeof Schema.String;
  completedAt: Schema.optional<typeof Schema.String>;
}>;
type Turn = typeof TurnSchema.Type;
declare const TurnCancellationRequestSchema: Schema.Struct<{
  turnId: typeof Schema.String;
  sessionId: typeof Schema.String;
  bindingKey: typeof Schema.String;
  requestedByEventId: typeof Schema.String;
  requestedAt: typeof Schema.String;
}>;
type TurnCancellationRequest = typeof TurnCancellationRequestSchema.Type;
declare const PermissionDecisionSchema: Schema.Struct<{
  turnId: typeof Schema.String;
  requestId: typeof Schema.String;
  requestFingerprint: typeof Schema.String;
  approved: typeof Schema.Boolean;
  decidedAt: typeof Schema.String;
}>;
type PermissionDecision = typeof PermissionDecisionSchema.Type;
//#endregion
export { AgentSession, AgentSessionSchema, ContextItem, ContextItemSchema, ContextProjection, ContextProjectionSchema, ContextProvenance, ContextProvenanceSchema, EffectDeliveryReceipt, EffectDeliveryReceiptSchema, JsonPrimitive, JsonValue, JsonValueSchema, PermissionDecision, PermissionDecisionSchema, Reaction, ReactionReceipt, ReactionReceiptSchema, ReactionSchema, SourceAnchor, SourceAnchorSchema, ThreadGoal, ThreadGoalSchema, ThreadGoalStatus, ThreadGoalStatusSchema, Turn, TurnCancellationRequest, TurnCancellationRequestSchema, TurnSchema, WorkEffect, WorkEffectSchema, WorkEvent, WorkEventSchema };
//# sourceMappingURL=index.d.ts.map
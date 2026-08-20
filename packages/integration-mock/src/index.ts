import {
  JsonValueSchema,
  type JsonValue,
  type WorkEffect,
} from "@openmatter/core";
import {
  IntegrationError,
  type WorkIntegration,
} from "@openmatter/integration";
import { Effect, Schema } from "effect";

export const MockNativeEventSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  authority: Schema.String,
  conversationId: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  messageId: Schema.optional(Schema.String),
  occurredAt: Schema.String,
  receivedAt: Schema.String,
  payload: Schema.optional(JsonValueSchema),
}).annotations({ identifier: "MockNativeEvent" });

export interface MockIntegration {
  readonly integration: WorkIntegration;
  readonly delivered: () => readonly WorkEffect[];
}

export const makeMockIntegration = (options: {
  readonly id: string;
  readonly failuresBeforeSuccess?: number;
}): MockIntegration => {
  const effects: WorkEffect[] = [];
  const receipts = new Map<string, JsonValue>();
  const attempts = new Map<string, number>();

  const integration: WorkIntegration = {
    manifest: {
      id: options.id,
      displayName: `Mock ${options.id}`,
      events: ["*"],
      operations: ["*"],
    },
    ingest: (input) =>
      Schema.decodeUnknown(MockNativeEventSchema)(input).pipe(
        Effect.mapError(
          (cause) =>
            new IntegrationError({
              message: `Invalid ${options.id} event`,
              retryable: false,
              cause,
            }),
        ),
        Effect.map((native) => [
          {
            schemaVersion: "0.1",
            id: `${options.id}:${native.id}`,
            type: `${options.id}.${native.type}`,
            occurredAt: native.occurredAt,
            receivedAt: native.receivedAt,
            idempotencyKey: `${options.id}:${native.id}`,
            source: {
              provider: options.id,
              authority: native.authority,
              ...(native.conversationId === undefined
                ? {}
                : { conversationId: native.conversationId }),
              ...(native.threadId === undefined
                ? {}
                : { threadId: native.threadId }),
              ...(native.messageId === undefined
                ? {}
                : { messageId: native.messageId }),
            },
            ...(native.payload === undefined
              ? {}
              : { payload: native.payload }),
            raw: {
              id: native.id,
              type: native.type,
              authority: native.authority,
              occurredAt: native.occurredAt,
              receivedAt: native.receivedAt,
              ...(native.conversationId === undefined
                ? {}
                : { conversationId: native.conversationId }),
              ...(native.threadId === undefined
                ? {}
                : { threadId: native.threadId }),
              ...(native.messageId === undefined
                ? {}
                : { messageId: native.messageId }),
              ...(native.payload === undefined
                ? {}
                : { payload: native.payload }),
            },
          },
        ]),
      ),
    deliver: (effect) =>
      Effect.suspend(() => {
        const existing = receipts.get(effect.idempotencyKey);
        if (existing !== undefined) {
          return Effect.succeed({ providerReceipt: existing });
        }
        const attempt = (attempts.get(effect.idempotencyKey) ?? 0) + 1;
        attempts.set(effect.idempotencyKey, attempt);
        if (attempt <= (options.failuresBeforeSuccess ?? 0)) {
          return Effect.fail(
            new IntegrationError({
              message: `Mock delivery failed on attempt ${attempt}`,
              retryable: true,
            }),
          );
        }

        const providerReceipt = { id: `mock:${effect.idempotencyKey}` };
        effects.push(effect);
        receipts.set(effect.idempotencyKey, providerReceipt);
        return Effect.succeed({ providerReceipt });
      }),
  };

  return {
    integration,
    delivered: () => [...effects],
  };
};

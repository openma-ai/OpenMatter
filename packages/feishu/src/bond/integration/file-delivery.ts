import type { JsonValue, WorkEffect } from "@openma/matter";
import { IntegrationError } from "@openma/matter/integration";
import { Effect } from "effect";
import {
  makeFeishuClient,
  makeFeishuCredentialsFor,
  type FeishuCredentialOption,
} from "./client.js";
import { makeFeishuDelivery } from "./delivery.js";
import {
  fileFailure,
  fileString,
  validFileReference,
  type FeishuFileReference,
  type FeishuFileResolver,
} from "./file-upload.js";
import { isRecord } from "./shared.js";

/** Validate persisted/legacy delivery proof against its authority-bound upload. */
export const isFeishuFileReceipt = (
  receipt: unknown,
  file: unknown,
  authority: string,
): boolean =>
  validFileReference(file, authority) &&
  isRecord(receipt) &&
  typeof receipt.messageId === "string" &&
  /^om_[A-Za-z0-9_-]+$/.test(receipt.messageId) &&
  fileString(receipt.fileKey) &&
  receipt.fileKey === file.fileKey;

/** Portable checkpoint; persistence and per-key serialization belong to the host. */
export interface FeishuFileCheckpoint {
  readonly binding: string;
  readonly idempotencyKey: string;
  readonly file?: FeishuFileReference;
  readonly replyStartedAt?: number;
  readonly receipt?: JsonValue;
}

export interface FeishuFileCheckpoints {
  readonly load: (key: string) => PromiseLike<FeishuFileCheckpoint | undefined>;
  /** Must durably complete before returning. No provider call follows a failed save. */
  readonly save: (
    key: string,
    checkpoint: FeishuFileCheckpoint,
  ) => PromiseLike<void>;
}

export interface FeishuFileDeliveryInput {
  /** A host-bound message.send/reply Effect with only target fields in input. */
  readonly effect: WorkEffect;
  /** Immutable resource identity; the resolver must authorize the Effect. */
  readonly resourceId: string;
  /** Stable across callback IDs; host must serialize calls for this key. */
  readonly checkpointKey: string;
  /** Optional host-attested upload receipt for migration/recovery. Never Agent input. */
  readonly file?: FeishuFileReference;
  /** Preserve the original first reply time when recovering a legacy fileKey. */
  readonly replyStartedAt?: number;
}

/**
 * Trusted host composition of file.upload and ordinary message delivery. Native
 * OperationCalls already protect one callback. This optional durable checkpoint
 * also protects a logical file delivery spanning different callback IDs.
 * No internal retry: an explicit resume may reuse a reply UUID only for <1 hour.
 */
export const makeFeishuFileDelivery = (options: {
  readonly credentials: FeishuCredentialOption;
  readonly fetch?: typeof globalThis.fetch;
  readonly resolve: FeishuFileResolver;
  readonly checkpoints: FeishuFileCheckpoints;
  readonly now?: () => number;
}) => {
  const deliver = makeFeishuDelivery(
    makeFeishuClient({
      credentialsFor: makeFeishuCredentialsFor(options.credentials),
      fetch: options.fetch ?? ((...args) => globalThis.fetch(...args)),
    }),
    { resolve: options.resolve },
  );
  return (request: FeishuFileDeliveryInput) =>
    Effect.gen(function* () {
      const { effect, resourceId, checkpointKey } = request;
      const input = effect.input;
      if (
        effect.integrationId !== "feishu" ||
        !["message.send", "message.reply"].includes(effect.operation) ||
        !isRecord(input) ||
        !fileString(input.authority) ||
        !fileString(resourceId) ||
        !fileString(checkpointKey) ||
        !fileString(effect.idempotencyKey) ||
        Object.keys(input).some(
          (key) =>
            !["authority", "chatId", "messageId", "inThread"].includes(key),
        ) ||
        (effect.operation === "message.reply"
          ? typeof input.messageId !== "string" ||
            !/^om_[A-Za-z0-9_-]+$/.test(input.messageId)
          : typeof input.chatId !== "string" ||
            !/^oc_[A-Za-z0-9_-]+$/.test(input.chatId)) ||
        (input.inThread !== undefined && typeof input.inThread !== "boolean") ||
        (request.file !== undefined &&
          !validFileReference(request.file, input.authority)) ||
        (request.replyStartedAt !== undefined &&
          (request.file === undefined ||
            !Number.isFinite(request.replyStartedAt)))
      ) {
        return yield* fileFailure(
          "Feishu file delivery requires a trusted target, resource and checkpoint key",
        );
      }
      const binding = JSON.stringify([
        effect.integrationId,
        effect.operation,
        input.authority,
        input.chatId ?? null,
        input.messageId ?? null,
        input.inThread === true,
        resourceId,
      ]);
      const persisted = yield* Effect.tryPromise({
        try: () => Promise.resolve(options.checkpoints.load(checkpointKey)),
        catch: () => fileFailure("Could not load Feishu file checkpoint"),
      });
      if (
        persisted !== undefined &&
        (!isRecord(persisted) ||
          persisted.binding !== binding ||
          !fileString(persisted.idempotencyKey) ||
          (persisted.file !== undefined &&
            !validFileReference(persisted.file, input.authority)) ||
          (persisted.replyStartedAt !== undefined &&
            (typeof persisted.replyStartedAt !== "number" ||
              !Number.isFinite(persisted.replyStartedAt))) ||
          (persisted.receipt !== undefined &&
            !isFeishuFileReceipt(
              persisted.receipt,
              persisted.file,
              input.authority,
            )))
      )
        return yield* fileFailure(
          "Feishu file checkpoint is invalid or bound to another resource or target",
        );
      let state: FeishuFileCheckpoint = persisted ?? {
        binding,
        idempotencyKey: effect.idempotencyKey,
        ...(request.file === undefined ? {} : { file: request.file }),
        ...(request.replyStartedAt === undefined
          ? {}
          : { replyStartedAt: request.replyStartedAt }),
      };
      const save = (next: FeishuFileCheckpoint) =>
        Effect.tryPromise({
          try: () =>
            Promise.resolve(options.checkpoints.save(checkpointKey, next)),
          catch: () =>
            new IntegrationError({
              message: "Could not save Feishu file checkpoint",
              retryable: false,
              effectState: "unknown",
            }),
        });
      if (state.receipt !== undefined)
        return { providerReceipt: state.receipt };
      if (persisted === undefined) yield* save(state);
      if (state.file === undefined) {
        if (persisted !== undefined)
          return yield* new IntegrationError({
            message:
              "Feishu file upload is pending/uncertain; check before uploading again",
            retryable: false,
            effectState: "unknown",
          });
        const uploaded = yield* deliver({
          ...effect,
          operation: "file.upload",
          input: { authority: input.authority, resourceId },
        });
        if (!validFileReference(uploaded.providerReceipt, input.authority))
          return yield* new IntegrationError({
            message: "Feishu upload has no file receipt",
            retryable: false,
            effectState: "unknown",
          });
        state = { ...state, file: uploaded.providerReceipt };
        yield* save(state);
      }
      if (!validFileReference(state.file, input.authority))
        return yield* fileFailure("Invalid Feishu checkpoint file authority");
      const now = (options.now ?? Date.now)();
      if (
        !Number.isFinite(now) ||
        (state.replyStartedAt !== undefined &&
          (now < state.replyStartedAt ||
            now - state.replyStartedAt >= 60 * 60 * 1000))
      ) {
        return yield* new IntegrationError({
          message:
            "Feishu file reply is uncertain and its UUID deduplication window expired",
          retryable: false,
          effectState: "unknown",
        });
      }
      state = { ...state, replyStartedAt: state.replyStartedAt ?? now };
      yield* save(state);
      const delivered = yield* deliver({
        ...effect,
        idempotencyKey: state.idempotencyKey,
        input: {
          ...input,
          file: {
            authority: state.file!.authority,
            fileKey: state.file!.fileKey,
          },
        },
      });
      yield* save({ ...state, receipt: delivered.providerReceipt ?? null });
      return delivered;
    });
};

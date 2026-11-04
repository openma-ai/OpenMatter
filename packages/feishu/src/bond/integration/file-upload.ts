import type { WorkEffect } from "@openma/matter";
import { IntegrationError } from "@openma/matter/integration";
import { Effect } from "effect";
import type { FeishuClient } from "./client.js";
import { isRecord } from "./shared.js";

/** Bytes are supplied only by a trusted host, never by operation JSON. */
export interface FeishuFileResource {
  readonly authority: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface FeishuFileRequest {
  readonly authority: string;
  readonly resourceId: string;
  readonly effect: WorkEffect;
}

/** Must authorize this authority/Effect and return immutable, host-owned bytes. */
export type FeishuFileResolver = (
  request: FeishuFileRequest,
) =>
  | FeishuFileResource
  | PromiseLike<FeishuFileResource>
  | Effect.Effect<FeishuFileResource, unknown>;

/** A host-attested key uploaded by this authority's application. Not a URL. */
export interface FeishuFileReference {
  readonly authority: string;
  readonly fileKey: string;
}

export const fileString = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim() === value &&
  value.length > 0 &&
  !/[\u0000-\u001f\u007f]/.test(value);

export const validFileReference = (
  value: unknown,
  authority: string,
): value is FeishuFileReference =>
  isRecord(value) &&
  value.authority === authority &&
  fileString(value.fileKey) &&
  Object.keys(value).every((key) => key === "authority" || key === "fileKey");

export const fileFailure = (message: string) =>
  new IntegrationError({
    message,
    retryable: false,
    effectState: "not-applied",
  });

export const uploadFeishuFileResource = (
  client: Pick<FeishuClient, "request">,
  resolve: FeishuFileResolver | undefined,
  effect: WorkEffect,
) =>
  Effect.gen(function* () {
    const input = effect.input;
    if (
      !isRecord(input) ||
      !fileString(input.authority) ||
      !fileString(input.resourceId) ||
      Object.keys(input).some(
        (key) => key !== "authority" && key !== "resourceId",
      )
    ) {
      return yield* fileFailure(
        "Feishu file.upload requires only authority and resourceId",
      );
    }
    if (resolve === undefined)
      return yield* fileFailure(
        "Feishu file.upload requires a trusted file resolver",
      );
    const request = {
      authority: input.authority,
      resourceId: input.resourceId,
      effect,
    };
    const file = yield* Effect.try({
      try: () => resolve(request),
      catch: () => fileFailure("Feishu file resolver failed"),
    }).pipe(
      Effect.flatMap((result) =>
        Effect.isEffect(result)
          ? result
          : Effect.tryPromise({
              try: () => Promise.resolve(result),
              catch: () => fileFailure("Feishu file resolver failed"),
            }),
      ),
      Effect.mapError(() => fileFailure("Feishu file resolver failed")),
    );
    if (!isRecord(file) || file.authority !== input.authority)
      return yield* fileFailure(
        "Feishu file resource authority does not match",
      );
    if (
      !fileString(file.filename) ||
      !/^[^/\\%\u0000-\u001f\u007f]+\.(html|zip)$/.test(file.filename) ||
      file.filename.includes("..") ||
      file.mimeType !==
        (file.filename.endsWith(".zip") ? "application/zip" : "text/html")
    ) {
      return yield* fileFailure(
        "Feishu file resource requires a single-level .html/.zip filename and matching MIME type",
      );
    }
    if (
      !(file.bytes instanceof Uint8Array) ||
      file.bytes.byteLength === 0 ||
      file.bytes.byteLength > 5 * 1024 * 1024
    ) {
      return yield* fileFailure(
        "Feishu file resource requires non-empty bytes of at most 5 MiB",
      );
    }
    const form = new FormData();
    form.set("file_type", "stream");
    form.set("file_name", file.filename);
    form.set(
      "file",
      new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }),
      file.filename,
    );
    const data = yield* client.request({
      authority: input.authority,
      method: "POST",
      path: "/im/v1/files",
      body: form,
      maxResponseBytes: 64 * 1024,
      signal: AbortSignal.timeout(45_000),
    });
    if (!isRecord(data) || !fileString(data.file_key)) {
      return yield* new IntegrationError({
        message: "Feishu file.upload returned no file_key",
        retryable: false,
        effectState: "unknown",
      });
    }
    return {
      providerReceipt: { authority: input.authority, fileKey: data.file_key },
    };
  });

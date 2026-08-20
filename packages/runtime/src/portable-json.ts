import type { AgentSessionHandle, OpenMAEvent } from "@openmatter/agent";
import type { JsonValue } from "@openmatter/core";
import { Effect } from "effect";
import { ContextProjectionError } from "./contracts.js";

export const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

export const isJsonObject = (
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const sessionHandleFrom = (
  value: JsonValue | undefined,
): AgentSessionHandle | undefined =>
  value !== undefined && isJsonObject(value) && typeof value.id === "string"
    ? { id: value.id, ...(value.raw === undefined ? {} : { raw: value.raw }) }
    : undefined;

export const outputFrom = (
  events: readonly OpenMAEvent[],
): JsonValue | undefined => {
  const output = [...events]
    .reverse()
    .find((event) =>
      ["assistant.output", "assistant.message", "turn.result"].includes(
        event.type,
      ),
    );
  if (output === undefined) return undefined;
  if (isJsonObject(output.payload) && output.payload.text !== undefined) {
    return output.payload.text;
  }
  return output.payload;
};

const canonicalize = (
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite JSON number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`Unsupported JSON value: ${typeof value}`);
  }
  if (seen.has(value)) throw new TypeError("Cyclic JSON value");
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((entry) => canonicalize(entry, seen));
    seen.delete(value);
    return result;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Only plain JSON objects can be canonicalized");
  }
  const result = Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => [
        key,
        canonicalize((value as Record<string, unknown>)[key], seen),
      ]),
  );
  seen.delete(value);
  return result;
};

export const canonicalJson = (value: unknown): string => {
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined) throw new TypeError("Value is not JSON data");
  return encoded;
};

export const digest = (
  value: unknown,
): Effect.Effect<string, ContextProjectionError> =>
  Effect.tryPromise({
    try: async () => {
      const encoded = new TextEncoder().encode(canonicalJson(value));
      const bytes = new Uint8Array(
        await globalThis.crypto.subtle.digest("SHA-256", encoded),
      );
      return [...bytes]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    },
    catch: (cause) =>
      new ContextProjectionError({
        message: "Context projection is not serializable",
        cause,
      }),
  });

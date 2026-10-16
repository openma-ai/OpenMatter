import { Schema } from "effect";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
const isJsonValue = (
  input: unknown,
  seen = new WeakSet<object>(),
): input is JsonValue => {
  if (input === null || typeof input === "string" || typeof input === "boolean")
    return true;
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

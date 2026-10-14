/** Portable JSON, structurally identical to `JsonValue` in `@openma/matter`. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Same rules as `JsonValueSchema` in `@openma/matter`: finite numbers,
 * primitives, arrays, and plain objects, without cycles. */
export const isJsonValue = (
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
  const prototype = Object.getPrototypeOf(input);
  const valid = Array.isArray(input)
    ? input.every((value) => isJsonValue(value, seen))
    : (prototype === Object.prototype || prototype === null) &&
      Object.values(input).every((value) => isJsonValue(value, seen));
  seen.delete(input);
  return valid;
};

/** A deep copy with every object and array frozen. */
export const frozenJson = <T>(value: T): T => {
  const snapshot = structuredClone(value);
  const freeze = (current: unknown): void => {
    if (current === null || typeof current !== "object") return;
    for (const nested of Object.values(current)) freeze(nested);
    Object.freeze(current);
  };
  freeze(snapshot);
  return snapshot;
};

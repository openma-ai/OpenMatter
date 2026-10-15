// Loop configuration: a JSON Schema subset a host renders as a form, and the
// validation that turns a submitted value into the config `install` receives.
// See docs/LOOPS.md, "Configuration".

import type { JsonValue } from "../index.js";

type Annotations = {
  readonly title?: string;
  readonly description?: string;
} & { readonly [hint: `x-${string}`]: JsonValue | undefined };

export type LoopConfigScalar =
  | (Annotations & {
      readonly type: "string";
      readonly enum?: readonly string[];
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly default?: string;
    })
  | (Annotations & {
      readonly type: "number" | "integer";
      readonly minimum?: number;
      readonly maximum?: number;
      readonly default?: number;
    })
  | (Annotations & {
      readonly type: "boolean";
      readonly default?: boolean;
    });

export type LoopConfigField =
  | LoopConfigScalar
  | (Annotations & {
      readonly type: "array";
      readonly items: LoopConfigScalar;
      readonly minItems?: number;
      readonly maxItems?: number;
      readonly default?: readonly (string | number | boolean)[];
    });

/** The root of a Loop configuration schema. Unknown keys are rejected. */
export interface LoopConfigSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, LoopConfigField>>;
  readonly required?: readonly string[];
}

export type LoopConfig = { readonly [key: string]: JsonValue };

export type LoopConfigResult =
  | { readonly ok: true; readonly config: LoopConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SCALAR_KEYS: Record<string, readonly string[]> = {
  string: ["enum", "minLength", "maxLength", "default"],
  number: ["minimum", "maximum", "default"],
  integer: ["minimum", "maximum", "default"],
  boolean: ["default"],
  array: ["items", "minItems", "maxItems", "default"],
};

const fieldProblems = (
  path: string,
  field: unknown,
  allowArray: boolean,
): string[] => {
  if (!isObject(field)) return [`${path} must be an object`];
  const type = field.type;
  if (
    typeof type !== "string" ||
    !(type in SCALAR_KEYS) ||
    (type === "array" && !allowArray)
  ) {
    return [`${path} has unsupported type ${String(type)}`];
  }
  const allowed = new Set([
    "type",
    "title",
    "description",
    ...SCALAR_KEYS[type]!,
  ]);
  const problems: string[] = [];
  for (const key of Object.keys(field)) {
    if (!allowed.has(key) && !key.startsWith("x-")) {
      problems.push(`${path} has unsupported keyword ${key}`);
    }
  }
  if (type === "array") {
    problems.push(...fieldProblems(`${path}.items`, field.items, false));
  }
  if (
    type === "string" &&
    field.enum !== undefined &&
    (!Array.isArray(field.enum) ||
      field.enum.length === 0 ||
      field.enum.some((v) => typeof v !== "string"))
  ) {
    problems.push(`${path}.enum must be a non-empty list of strings`);
  }
  if (problems.length === 0 && field.default !== undefined) {
    problems.push(
      ...valueProblems(path, field.default, field as LoopConfigField),
    );
  }
  return problems;
};

/** Problems that make a configuration schema unusable. Empty when valid. */
export const loopConfigSchemaProblems = (schema: unknown): string[] => {
  if (!isObject(schema) || schema.type !== "object") {
    return ["configSchema must be an object schema"];
  }
  if (!isObject(schema.properties)) {
    return ["configSchema.properties must be an object"];
  }
  const problems: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!["type", "properties", "required"].includes(key)) {
      problems.push(`configSchema has unsupported keyword ${key}`);
    }
  }
  for (const [name, field] of Object.entries(schema.properties)) {
    problems.push(...fieldProblems(`configSchema.${name}`, field, true));
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some((r) => typeof r !== "string")
    ) {
      problems.push("configSchema.required must be a list of strings");
    } else {
      for (const name of schema.required as string[]) {
        if (!(name in schema.properties)) {
          problems.push(`configSchema.required names unknown field ${name}`);
        }
      }
    }
  }
  return problems;
};

const valueProblems = (
  path: string,
  value: unknown,
  field: LoopConfigField,
): string[] => {
  switch (field.type) {
    case "string": {
      if (typeof value !== "string") return [`${path} must be a string`];
      const problems: string[] = [];
      if (field.enum !== undefined && !field.enum.includes(value)) {
        problems.push(`${path} must be one of ${field.enum.join(", ")}`);
      }
      if (field.minLength !== undefined && value.length < field.minLength) {
        problems.push(
          `${path} must have at least ${field.minLength} characters`,
        );
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        problems.push(
          `${path} must have at most ${field.maxLength} characters`,
        );
      }
      return problems;
    }
    case "number":
    case "integer": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return [`${path} must be a number`];
      }
      if (field.type === "integer" && !Number.isInteger(value)) {
        return [`${path} must be an integer`];
      }
      const problems: string[] = [];
      if (field.minimum !== undefined && value < field.minimum) {
        problems.push(`${path} must be at least ${field.minimum}`);
      }
      if (field.maximum !== undefined && value > field.maximum) {
        problems.push(`${path} must be at most ${field.maximum}`);
      }
      return problems;
    }
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path} must be a boolean`];
    case "array": {
      if (!Array.isArray(value)) return [`${path} must be a list`];
      const problems: string[] = [];
      if (field.minItems !== undefined && value.length < field.minItems) {
        problems.push(`${path} must have at least ${field.minItems} items`);
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        problems.push(`${path} must have at most ${field.maxItems} items`);
      }
      value.forEach((item, i) =>
        problems.push(...valueProblems(`${path}[${i}]`, item, field.items)),
      );
      return problems;
    }
  }
};

/**
 * Validates a submitted configuration against a Loop's schema and fills in
 * defaults. Unknown keys and missing required fields are problems. A Loop
 * without a schema accepts only an absent or empty configuration.
 */
export const resolveLoopConfig = (
  schema: LoopConfigSchema | undefined,
  input: JsonValue | undefined,
): LoopConfigResult => {
  const value = input ?? {};
  if (!isObject(value)) {
    return { ok: false, problems: ["config must be an object"] };
  }
  if (schema === undefined) {
    return Object.keys(value).length === 0
      ? { ok: true, config: {} }
      : { ok: false, problems: ["this Loop takes no configuration"] };
  }
  const problems: string[] = [];
  const config: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    if (!(key in schema.properties)) problems.push(`unknown field ${key}`);
  }
  for (const [name, field] of Object.entries(schema.properties)) {
    const given = value[name];
    if (given === undefined) {
      if (field.default !== undefined) {
        config[name] = structuredClone(field.default) as JsonValue;
      } else if (schema.required?.includes(name)) {
        problems.push(`${name} is required`);
      }
      continue;
    }
    const found = valueProblems(name, given, field);
    if (found.length > 0) problems.push(...found);
    else config[name] = structuredClone(given) as JsonValue;
  }
  return problems.length === 0 ? { ok: true, config } : { ok: false, problems };
};

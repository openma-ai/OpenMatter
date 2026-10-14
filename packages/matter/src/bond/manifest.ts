// Binding manifest and resource catalog. See docs/BONDS.md, "Manifest and
// resource catalog".
//
// A host renders setup forms, pickers, and grants from these values without
// knowing the provider. Resource IDs are opaque to the host: it stores and
// compares them as strings and asks the binding what they mean.

import type { Effect } from "effect";
import type { BondProvider, ProviderError } from "./ports.js";
import type { LinkMethod, ProviderAppConfig, ProviderKind } from "./types.js";

/** The JSON Schema subset a host must render. */
export type BondFormField =
  | {
      readonly type: "string";
      readonly title: string;
      readonly description?: string;
      readonly format?: "uri";
      readonly enum?: readonly string[];
      readonly default?: string;
      /** Stored sealed and never returned to clients. */
      readonly "x-secret"?: true;
    }
  | {
      readonly type: "integer";
      readonly title: string;
      readonly description?: string;
      readonly minimum?: number;
      readonly maximum?: number;
      readonly default?: number;
    }
  | {
      readonly type: "boolean";
      readonly title: string;
      readonly description?: string;
      readonly default?: boolean;
    };

export interface BondFormSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, BondFormField>>;
  readonly required?: readonly string[];
}

export interface BondOperation {
  /** Stable name used in grants and audit facts, such as `push`. */
  readonly name: string;
  readonly description: string;
  readonly access: "read" | "write";
}

export interface BondResourceKind {
  /** The prefix of resource IDs of this kind, such as `project`. */
  readonly kind: string;
  readonly title: string;
  readonly operations: readonly BondOperation[];
}

export interface BondManifest {
  readonly provider: ProviderKind;
  readonly title: string;
  readonly docsUrl?: string;
  /**
   * What an administrator fills in to enable the ProviderApp in a tenant.
   * Empty `properties` when the ProviderApp is configured by the deployment.
   */
  readonly setupSchema: BondFormSchema;
  /** How users can link, before the ProviderApp's link method policy narrows it. */
  readonly linkMethods: readonly LinkMethod[];
  readonly resourceKinds: readonly BondResourceKind[];
}

/** One resource as a picker shows it. `id` is `<kind>:<key>`. */
export interface BondResource {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly url?: string;
}

export interface BondResourcePage {
  readonly items: readonly BondResource[];
  /** Opaque. Absent on the last page. */
  readonly nextCursor?: string;
}

export type BondResourceRejection =
  | "malformed_id"
  | "unknown_kind"
  | "unknown_operation"
  | "not_found"
  | "insufficient_access";

export type BondResourceValidation =
  | { readonly ok: true; readonly resource: BondResource }
  | {
      readonly ok: false;
      readonly reason: BondResourceRejection;
      readonly message: string;
    };

/**
 * Implemented by each binding. The caller supplies the token, normally from
 * `Bond.credential`, so the caller decides whose access is checked. A host
 * that must check both the requester and the app principal calls `validate`
 * once with each token.
 */
export interface BondResourceCatalog {
  readonly list: (input: {
    readonly config: ProviderAppConfig;
    readonly token: string;
    readonly query?: string;
    readonly cursor?: string;
    /** Page size hint. Bindings cap it. */
    readonly limit?: number;
  }) => Effect.Effect<BondResourcePage, ProviderError>;
  readonly validate: (input: {
    readonly config: ProviderAppConfig;
    readonly token: string;
    readonly resource: string;
    readonly operations: readonly string[];
  }) => Effect.Effect<BondResourceValidation, ProviderError>;
}

/** Everything a host registers for one provider. */
export interface BondBinding {
  readonly manifest: BondManifest;
  readonly provider: BondProvider;
  readonly resources: BondResourceCatalog;
}

const NAME = /^[a-z][a-z0-9_]*$/;

/** Splits `<kind>:<key>`. The key is non-empty and may contain `:`. */
export const parseResourceId = (
  id: string,
): { readonly kind: string; readonly key: string } | undefined => {
  const at = id.indexOf(":");
  if (at <= 0 || at === id.length - 1) return undefined;
  const kind = id.slice(0, at);
  if (!NAME.test(kind)) return undefined;
  return { kind, key: id.slice(at + 1) };
};

export const resourceId = (kind: string, key: string | number): string =>
  `${kind}:${key}`;

/**
 * Checks an ID's shape and operations against the manifest, before any
 * provider call. Returns the parsed ID and kind, or the rejection.
 */
export const checkResourceRequest = (
  manifest: BondManifest,
  resource: string,
  operations: readonly string[],
):
  | {
      readonly ok: true;
      readonly kind: BondResourceKind;
      readonly key: string;
    }
  | Extract<BondResourceValidation, { ok: false }> => {
  const parsed = parseResourceId(resource);
  if (parsed === undefined) {
    return {
      ok: false,
      reason: "malformed_id",
      message: "Resource IDs have the form <kind>:<key>",
    };
  }
  const kind = manifest.resourceKinds.find((k) => k.kind === parsed.kind);
  if (kind === undefined) {
    return {
      ok: false,
      reason: "unknown_kind",
      message: `${manifest.provider} has no resource kind ${parsed.kind}`,
    };
  }
  const unknown = operations.filter(
    (op) => !kind.operations.some((o) => o.name === op),
  );
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: "unknown_operation",
      message: `${parsed.kind} does not support ${unknown.join(", ")}`,
    };
  }
  return { ok: true, kind, key: parsed.key };
};

/** Problems that make a manifest unusable by a host. Empty when valid. */
export const manifestProblems = (manifest: BondManifest): string[] => {
  const problems: string[] = [];
  const kinds = new Set<string>();
  for (const kind of manifest.resourceKinds) {
    if (!NAME.test(kind.kind)) problems.push(`invalid kind ${kind.kind}`);
    if (kinds.has(kind.kind)) problems.push(`duplicate kind ${kind.kind}`);
    kinds.add(kind.kind);
    if (kind.operations.length === 0) {
      problems.push(`kind ${kind.kind} has no operations`);
    }
    const ops = new Set<string>();
    for (const op of kind.operations) {
      if (!NAME.test(op.name)) {
        problems.push(`invalid operation ${kind.kind}.${op.name}`);
      }
      if (ops.has(op.name)) {
        problems.push(`duplicate operation ${kind.kind}.${op.name}`);
      }
      ops.add(op.name);
    }
  }
  const props = Object.keys(manifest.setupSchema.properties);
  for (const name of manifest.setupSchema.required ?? []) {
    if (!props.includes(name))
      problems.push(`required field ${name} is not defined`);
  }
  return problems;
};

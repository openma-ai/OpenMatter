import { Data } from "effect";

/** Stable failure reasons. Applications map them to their own error codes. */
export type BondFailureReason =
  | "config"
  | "store"
  | "cipher"
  | "provider"
  | "provider_not_registered"
  | "invalid_principal_request"
  | "link_required"
  | "unattended_unsupported"
  | "app_not_configured"
  | "app_disallowed"
  | "installation_required"
  | "user_output_disabled"
  | "participant_not_allowed"
  | "method_disallowed"
  | "scope_not_allowed"
  | "pat_lifetime_exceeded"
  | "identity_mismatch"
  | "provider_user_linked_elsewhere"
  | "refresh_failed"
  | "expired"
  | "revoked"
  | "not_found"
  | "installation_owned_elsewhere";

export class BondError extends Data.TaggedError("BondError")<{
  readonly reason: BondFailureReason;
  readonly message: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}> {}

export const bondError = (
  reason: BondFailureReason,
  message: string,
  options: { readonly retryable?: boolean; readonly cause?: unknown } = {},
): BondError =>
  new BondError({
    reason,
    message,
    retryable: options.retryable ?? false,
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });

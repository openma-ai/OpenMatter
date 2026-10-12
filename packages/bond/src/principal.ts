import type { ExecutionPrincipalRequest } from "@openmatter/credentials";
import { Either } from "effect";
import { bondError, type BondError } from "./errors.js";
import type {
  FallbackReason,
  Installation,
  PrincipalResolution,
  ProviderAppConfig,
  UserLink,
} from "./types.js";

/** The requester's link as seen at selection time. */
export type LinkState =
  | { readonly usable: true; readonly link: UserLink }
  | { readonly usable: false; readonly reason: FallbackReason };

export interface PrincipalInputs {
  readonly config: ProviderAppConfig;
  /** The active Installation to use for the app principal, if any. */
  readonly installation: Installation | undefined;
  readonly link: LinkState;
  readonly request: ExecutionPrincipalRequest;
  /**
   * The Session creator. When it differs from `request.requesterId`, the
   * requester is another participant, which needs `participantsAsPrincipal`.
   */
  readonly sessionCreatorId?: string;
  readonly access: "read" | "write";
  /** Whether the provider marks delegated output natively. */
  readonly delegationMarker: boolean;
}

/**
 * Pure principal selection. Implements the policy table and rules 1, 2, 5,
 * and 6 in docs/BONDS.md, plus the IDENTITY_MODEL opt-in for providers
 * without a delegation marker.
 */
export const selectPrincipal = (
  inputs: PrincipalInputs,
): Either.Either<PrincipalResolution, BondError> => {
  const { config, installation, link, request } = inputs;
  const policy = config.principalPolicy;
  const unattended = request.requesterId === undefined;

  const app = (
    fallback: PrincipalResolution["fallback"],
  ): Either.Either<PrincipalResolution, BondError> =>
    installation === undefined
      ? Either.left(
          unattended
            ? bondError(
                "unattended_unsupported",
                `${config.id} has no app principal, so unattended work is unsupported`,
              )
            : bondError(
                "app_not_configured",
                `${config.id} has no app principal configured`,
              ),
        )
      : Either.right({
          principal: {
            kind: "app",
            providerAppId: config.id,
            installationId: installation.id,
          },
          policy,
          fallback,
          ...(request.requesterId === undefined
            ? {}
            : { requesterId: request.requesterId }),
        });

  // Rule 2: unattended work never borrows a person's link.
  if (unattended) {
    if (policy === "user_only") {
      return Either.left(
        bondError(
          "unattended_unsupported",
          `${config.id} uses user_only, so unattended work is unsupported`,
        ),
      );
    }
    return app(false);
  }

  if (request.runAs === "app" || policy === "app") {
    if (policy === "user_only") {
      return Either.left(
        bondError(
          "app_not_configured",
          `${config.id} uses user_only and has no app principal`,
        ),
      );
    }
    return app(false);
  }

  // Rule 6: another participant needs the explicit opt-in.
  if (
    inputs.sessionCreatorId !== undefined &&
    inputs.sessionCreatorId !== request.requesterId &&
    config.participantsAsPrincipal !== true
  ) {
    return Either.left(
      bondError(
        "participant_not_allowed",
        `${config.id} runs user operations only as the Session creator`,
      ),
    );
  }

  if (link.usable) {
    if (
      inputs.access === "write" &&
      !inputs.delegationMarker &&
      !config.allowUserPrincipalOutput
    ) {
      return Either.left(
        bondError(
          "user_output_disabled",
          `${config.id} has no delegation marker and user-principal output is not enabled`,
        ),
      );
    }
    return Either.right({
      principal: {
        kind: "user",
        providerAppId: config.id,
        userLinkId: link.link.id,
        ...(installation === undefined
          ? {}
          : { installationId: installation.id }),
      },
      policy,
      fallback: false,
      requesterId: request.requesterId,
    });
  }

  // Rule 1: fallback only when the policy names it.
  if (policy === "user" && installation !== undefined) {
    return app({ reason: link.reason });
  }
  return Either.left(
    bondError(
      link.reason === "no_link" ? "link_required" : link.reason,
      link.reason === "no_link"
        ? `A linked ${config.provider} account is required`
        : `The linked ${config.provider} account is ${link.reason}; link it again`,
    ),
  );
};

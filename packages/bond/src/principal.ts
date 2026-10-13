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
  | {
      readonly usable: false;
      readonly reason: Exclude<FallbackReason, "policy_app">;
    };

export interface PrincipalInputs {
  readonly config: ProviderAppConfig;
  /** The active Installation to use for the app principal, if any. */
  readonly installation: Installation | undefined;
  readonly link: LinkState;
  readonly request: ExecutionPrincipalRequest;
  /**
   * The Session creator. The requester acts as the user principal only when
   * they are the creator, or with `participantsAsPrincipal`. When absent, the
   * requester is treated as another participant.
   */
  readonly sessionCreatorId?: string;
  readonly access: "read" | "write";
  /** Whether the provider marks delegated output natively. */
  readonly delegationMarker: boolean;
}

/** Runtime check of the request shape, for callers outside TypeScript. */
const requestProblem = (
  request: ExecutionPrincipalRequest,
): string | undefined => {
  const r = request as {
    readonly trigger?: unknown;
    readonly runAs?: unknown;
    readonly requesterId?: unknown;
  };
  if (r.trigger !== "attended" && r.trigger !== "unattended") {
    return "trigger must be attended or unattended";
  }
  if (r.runAs !== "app" && r.runAs !== "requester") {
    return "runAs must be app or requester";
  }
  if (r.runAs === "requester") {
    if (r.trigger !== "attended")
      return "runAs requester needs an attended trigger";
    if (typeof r.requesterId !== "string" || r.requesterId === "") {
      return "runAs requester needs a requesterId";
    }
  }
  return undefined;
};

/**
 * Pure principal selection. Implements the resolution table and rules 1, 2,
 * 3, 5, and 6 in docs/BONDS.md "Principal selection".
 */
export const selectPrincipal = (
  inputs: PrincipalInputs,
): Either.Either<PrincipalResolution, BondError> => {
  const { config, installation, link, request } = inputs;
  const policy = config.principalPolicy;
  const problem = requestProblem(request);
  if (problem !== undefined) {
    return Either.left(bondError("invalid_principal_request", problem));
  }
  const unattended = request.trigger === "unattended";
  const base = {
    policy,
    trigger: request.trigger,
    ...(request.requesterId === undefined
      ? {}
      : { requesterId: request.requesterId }),
  };

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
          ...base,
          principal: {
            kind: "app",
            providerAppId: config.id,
            installationId: installation.id,
          },
          fallback,
        });

  if (request.runAs === "app") {
    // Rule 2: unattended work never borrows a person's link, and user_only
    // offers nothing else.
    if (policy === "user_only") {
      return Either.left(
        unattended
          ? bondError(
              "unattended_unsupported",
              `${config.id} uses user_only, so unattended work is unsupported`,
            )
          : bondError(
              "app_disallowed",
              `${config.id} uses user_only and does not act as the app`,
            ),
      );
    }
    return app(false);
  }

  // runAs requester: attended and with a requester, checked above.
  if (policy === "app") return app({ reason: "policy_app" });

  // Rule 6: another participant needs the explicit opt-in. An unknown
  // creator counts as another participant.
  if (
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
    // Rule 3: no silent switch to the app when the opt-in is missing.
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
      ...base,
      principal: {
        kind: "user",
        providerAppId: config.id,
        userLinkId: link.link.id,
        ...(installation === undefined
          ? {}
          : { installationId: installation.id }),
      },
      fallback: false,
    });
  }

  // Rule 1: fall back only where the policy names it. Without an
  // Installation the link's own failure is the useful answer.
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

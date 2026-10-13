import { Effect } from "effect";
import { describe, expect, it } from "vitest";

describe("CredentialResolver", () => {
  it("resolves one authority-scoped credential through the common request shape", async () => {
    const { makeCredentialResolver } =
      await import("../packages/credentials/src/index.js");
    const seen: unknown[] = [];
    const resolver = makeCredentialResolver((request) => {
      seen.push(request);
      return { token: `token:${request.authority}` };
    });

    const credential = await Effect.runPromise(
      resolver.resolve({ integrationId: "slack", authority: "TWORK" }),
    );

    expect(seen).toEqual([{ integrationId: "slack", authority: "TWORK" }]);
    expect(credential).toEqual({ token: "token:TWORK" });
  });

  it("contains rejected credential sources as typed retryable failures", async () => {
    const { CredentialError, makeCredentialResolver } =
      await import("../packages/credentials/src/index.js");
    const resolver = makeCredentialResolver(async () => {
      throw new Error("vault unavailable");
    });

    const result = await Effect.runPromise(
      Effect.either(
        resolver.resolve({ integrationId: "slack", authority: "TWORK" }),
      ),
    );

    expect(result).toMatchObject({
      _tag: "Left",
      left: {
        _tag: "CredentialError",
        integrationId: "slack",
        authority: "TWORK",
        retryable: true,
      },
    });
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(CredentialError);
    }
  });

  it("can bind static credentials to one authority", async () => {
    const { staticCredentialResolver } =
      await import("../packages/credentials/src/index.js");
    const resolver = staticCredentialResolver(
      { token: "fixed" },
      { integrationId: "slack", authority: "TWORK" },
    );

    await expect(
      Effect.runPromise(
        resolver.resolve({ integrationId: "slack", authority: "TOTHER" }),
      ),
    ).rejects.toThrow("No credential is bound");
  });

  it("passes an optional execution principal through to the source unchanged", async () => {
    const { makeCredentialResolver } =
      await import("../packages/credentials/src/index.js");
    const seen: unknown[] = [];
    const resolver = makeCredentialResolver((request) => {
      seen.push(request.principal);
      return { token: "t" };
    });
    const principal = {
      tenantId: "w1",
      trigger: "attended",
      runAs: "requester",
      requesterId: "u1",
    } as const;

    await Effect.runPromise(
      resolver.resolve({ integrationId: "gitlab", authority: "a", principal }),
    );
    await Effect.runPromise(
      resolver.resolve({ integrationId: "gitlab", authority: "a" }),
    );
    expect(seen).toEqual([principal, undefined]);
  });

  it("refuses a requester principal from a static installation credential", async () => {
    const { CredentialError, staticCredentialResolver } =
      await import("../packages/credentials/src/index.js");
    const fixed = staticCredentialResolver(
      { token: "fixed" },
      { integrationId: "slack", authority: "TWORK" },
    );
    const resolve = (
      principal: Parameters<typeof fixed.resolve>[0]["principal"],
    ) =>
      Effect.runPromise(
        Effect.either(
          fixed.resolve({
            integrationId: "slack",
            authority: "TWORK",
            ...(principal === undefined ? {} : { principal }),
          }),
        ),
      );

    const requester = await resolve({
      tenantId: "w1",
      trigger: "attended",
      runAs: "requester",
      requesterId: "u1",
    });
    expect(requester._tag).toBe("Left");
    if (requester._tag === "Left") {
      expect(requester.left).toBeInstanceOf(CredentialError);
      expect(requester.left.retryable).toBe(false);
    }

    for (const principal of [
      undefined,
      { tenantId: "w1", trigger: "unattended", runAs: "app" },
      { tenantId: "w1", trigger: "attended", runAs: "app", requesterId: "u1" },
    ] as const) {
      expect(await resolve(principal)).toMatchObject({
        _tag: "Right",
        right: { token: "fixed" },
      });
    }
  });

  it("rules out a requester principal without an attended trigger or requester at the type level", () => {
    type Request =
      import("../packages/credentials/src/index.js").ExecutionPrincipalRequest;
    // @ts-expect-error runAs requester needs requesterId
    const noRequester: Request = {
      tenantId: "w1",
      trigger: "attended",
      runAs: "requester",
    };
    // @ts-expect-error runAs requester is attended only
    const unattended: Request = {
      tenantId: "w1",
      trigger: "unattended",
      runAs: "requester",
      requesterId: "u1",
    };
    expect([noRequester, unattended]).toHaveLength(2);
  });
});

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
});

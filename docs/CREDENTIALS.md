# Credential resolution

`@openmatter/credentials` is the runtime boundary between a Work Integration
and credential ownership. It resolves one provider installation without
requiring the integration to know whether the credential came from an
environment variable, encrypted database, OAuth service, or managed control
plane.

```ts
import { makeCredentialResolver } from "@openmatter/credentials";
import { makeSlackIntegration } from "@openmatter/integration-slack";

const credentials = makeCredentialResolver(async (request) => {
  return credentialVault.resolve(request.integrationId, request.authority);
});

const slack = makeSlackIntegration({ credentials });
```

The request contains only trusted public identifiers:

```ts
interface CredentialRequest {
  integrationId: string;
  authority: string;
}
```

The adapter constructs this request from the installation authority attached
to ingress, Context reads, and authorized Effects. Agent output cannot replace
the resolver or select arbitrary credential material.

`makeCredentialResolver` adapts synchronous, Promise, and Effect loaders to one
typed Effect boundary. `staticCredentialResolver` is a deployment convenience
for one explicitly bound installation; it rejects requests for every other
integration or authority.

This package deliberately does not implement OAuth authorization pages,
callbacks, PKCE/state, encrypted token storage, refresh locking, or revocation.
Those are deployment/control-plane responsibilities. An OAuth implementation
can expose its current installation token through the same resolver, so a
self-hosted service and a managed service remain interchangeable without
changing the Work Integration.

Credential values are opaque live application data. OpenMatter does not place
them in WorkEvents, Context, Agent input, receipts, profiles, or logs, and the
resolver does not cache them. Rotation and refresh policy remain owned by the
credential source.

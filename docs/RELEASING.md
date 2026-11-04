# Releasing

Every package under `packages/` that is not `private` is published to npm,
all at the same version. Today that is `@openma/matter` (the kernel, one
subpath export per port), `@openma/matter-loop` (the Loop guest SDK),
`@openma/matter-gitlab`, `@openma/matter-feishu`, `@openma/matter-slack`, the Project packages
`@openma/matter-orchestration`, `@openma/matter-project`, and
`@openma/matter-project-host`, and the Node.js host adapters
`@openma/matter-store-sqlite`, `@openma/matter-inbox-sqlite`,
`@openma/matter-store-mysql`, `@openma/matter-inbox-mysql`, and
`@openma/matter-host-local`. Consumers install exact
versions from npm; git dependencies on this repository are not supported.

A package becomes public when it has a consumer outside this repository:
remove `"private": true`, add the same `license`, `repository`, and
`publishConfig` as the existing public packages, and bootstrap it (below).
`check` refuses a public package that depends on a private one.

## A release

1. Bump `version` in every public `packages/*/package.json` to the new version
   in one pull request. `node scripts/release.mjs check` verifies that they
   agree, carry the publish metadata (license, repository, public access),
   and depend on no private package.
2. After it merges, tag the merge commit `vX.Y.Z` and push the tag.
3. `.github/workflows/release.yml` checks the tag against the versions, runs
   typecheck, tests, and the build, then publishes each package whose version
   is not on npm yet. It uses npm trusted publishing (GitHub OIDC, the `npm`
   environment, no token), so every version carries provenance. Re-running
   the workflow for a tag skips versions already published.

`pnpm pack` rewrites `workspace:*` dependencies to the exact sibling version,
so one release is always installed as a consistent set.

## A prerelease

Use one prerelease version across all 13 public packages, for example
`0.2.9-file-resources.0`, then push the matching tag
`v0.2.9-file-resources.0` after committing and reviewing the changes. The same
release workflow runs all checks and publishes with provenance, but chooses
`file-resources` for `v*-file-resources.*` refs, `next` for other prerelease
refs, and `latest` only for stable refs. Prereleases do not move `latest`.

The publish CLI requires an explicit non-`latest` distribution tag for a
prerelease (including `bootstrap`). The equivalent CI command is:

```bash
node scripts/release.mjs check --tag v0.2.9-file-resources.0
node scripts/release.mjs publish --dist-tag file-resources
```

Use the two-argument `--dist-tag NAME` form. Tags must start with a lowercase
letter and contain only lowercase letters, digits, and single hyphen-separated
segments; semver-like tags such as `v1`, duplicate options, and missing values
are rejected before contacting npm. Stable versions still default to `latest`
when `--dist-tag` is omitted. `pnpm pack` continues to replace `workspace:*`
with the exact prerelease sibling versions; private package versions need no
bump. Consumers can opt in with, for example:

```bash
npm install @openma/matter-feishu@file-resources
# Or pin the exact version:
npm install @openma/matter-feishu@0.2.9-file-resources.0
```

## A new package

npm attaches a trusted publisher only to a package that already exists, so
the first version of a new package is published by hand:

```bash
npm login
pnpm install && NODE_OPTIONS=--max-old-space-size=8192 pnpm build
node scripts/release.mjs bootstrap --dry-run   # lists packages missing from npm
node scripts/release.mjs bootstrap
```

`bootstrap` publishes each missing package without provenance, asking for a
one-time password when npm needs one. It then runs `npm trust github` so that
`release.yml` in `openma-ai/OpenMatter`, environment `npm`, may publish later
versions. After that, the package releases like every other.

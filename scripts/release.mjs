#!/usr/bin/env node
// Publishes the public workspace packages to npm. See docs/RELEASING.md.
//
//   node scripts/release.mjs check [--tag vX.Y.Z]
//     Every public package has the same version (and it matches the tag),
//     carries the publish metadata, and depends on no private package.
//   node scripts/release.mjs publish
//     CI: packs every package whose version is not on npm yet and publishes it
//     with npm trusted publishing and provenance. Re-running is a no-op.
//   node scripts/release.mjs bootstrap [--dry-run]
//     Local, once per new package: publishes it without provenance (asking for
//     a one-time password), then attaches the GitHub trusted publisher so
//     later versions come from CI. npm only accepts a trusted publisher for a
//     package that already exists.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const ROOT = resolve(import.meta.dirname, "..");
const REPOSITORY = "openma-ai/OpenMatter";
const WORKFLOW = "release.yml";
const ENVIRONMENT = "npm";
const OUT = join(ROOT, ".release");

const workspacePackages = (root = ROOT) =>
  readdirSync(join(root, "packages"))
    .map((dir) => ({ dir: join(root, "packages", dir) }))
    .filter(({ dir }) => existsSync(join(dir, "package.json")))
    .map(({ dir }) => ({
      dir,
      ...JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
    }));

export const publicPackages = (root = ROOT) =>
  workspacePackages(root)
    .filter((pkg) => pkg.private !== true)
    .sort((a, b) => a.name.localeCompare(b.name));

// A published package must not depend on a workspace package that is never
// published: npm would accept it and consumers would fail to install.
export const privateDependencyProblems = (root = ROOT) => {
  const privateNames = new Set(
    workspacePackages(root)
      .filter((pkg) => pkg.private === true)
      .map((pkg) => pkg.name),
  );
  return publicPackages(root).flatMap((pkg) =>
    Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies })
      .filter((name) => privateNames.has(name))
      .map((name) => `${pkg.name} depends on private package ${name}`),
  );
};

export const versionProblems = (packages, tag) => {
  const problems = [...privateDependencyProblems()];
  const versions = new Set(packages.map((pkg) => pkg.version));
  if (versions.size !== 1) {
    problems.push(
      `packages disagree on the version: ${packages
        .map((pkg) => `${pkg.name}@${pkg.version}`)
        .join(", ")}`,
    );
  }
  if (tag !== undefined) {
    for (const pkg of packages) {
      if (`v${pkg.version}` !== tag) {
        problems.push(`${pkg.name}@${pkg.version} does not match tag ${tag}`);
      }
    }
  }
  for (const pkg of packages) {
    if (pkg.license !== "Apache-2.0")
      problems.push(`${pkg.name} has no license`);
    if (pkg.repository?.url !== `git+https://github.com/${REPOSITORY}.git`) {
      problems.push(`${pkg.name} repository.url must point at ${REPOSITORY}`);
    }
    if (pkg.publishConfig?.access !== "public") {
      problems.push(`${pkg.name} publishConfig.access must be public`);
    }
  }
  return problems;
};

const published = (name, version) =>
  spawnSync("npm", ["view", `${name}@${version}`, "version"], {
    encoding: "utf8",
  }).stdout.trim() === version;

const pack = (pkg) => {
  mkdirSync(OUT, { recursive: true });
  // pnpm rewrites workspace:* to the exact sibling versions.
  const out = execFileSync(
    "pnpm",
    ["pack", "--pack-destination", OUT, "--json"],
    { cwd: pkg.dir, encoding: "utf8" },
  );
  return JSON.parse(out).filename;
};

const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const fail = (problems) => {
  for (const problem of problems) console.error(`error: ${problem}`);
  process.exit(1);
};

const command = process.argv[2];
const packages = publicPackages();

if (command === "check") {
  const problems = versionProblems(packages, argValue("--tag"));
  if (problems.length > 0) fail(problems);
  console.log(`${packages.length} packages at ${packages[0].version}`);
} else if (command === "publish") {
  const problems = versionProblems(packages, process.env.GITHUB_REF_NAME);
  if (problems.length > 0) fail(problems);
  for (const pkg of packages) {
    if (published(pkg.name, pkg.version)) {
      console.log(`${pkg.name}@${pkg.version} is already on npm`);
      continue;
    }
    const tarball = pack(pkg);
    execFileSync(
      "npm",
      ["publish", tarball, "--access", "public", "--provenance"],
      {
        stdio: "inherit",
      },
    );
  }
} else if (command === "bootstrap") {
  const dryRun = process.argv.includes("--dry-run");
  const problems = versionProblems(packages);
  if (problems.length > 0) fail(problems);
  const missing = packages.filter((pkg) => !published(pkg.name, pkg.version));
  console.log(
    missing.length === 0
      ? "every package is on npm already"
      : `to publish: ${missing.map((pkg) => pkg.name).join(", ")}`,
  );
  if (dryRun || missing.length === 0) process.exit(0);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let otp = "";
  // A one-time password stays valid for about 30 seconds and can be reused in
  // that window; ask again only when npm rejects it.
  const withOtp = async (args) => {
    for (;;) {
      if (otp === "")
        otp = (await rl.question("npm one-time password: ")).trim();
      const result = spawnSync("npm", [...args, `--otp=${otp}`], {
        encoding: "utf8",
      });
      process.stdout.write(result.stdout);
      if (result.status === 0) return;
      if (/EOTP|one-time password/i.test(result.stderr)) {
        otp = "";
        continue;
      }
      process.stderr.write(result.stderr);
      throw new Error(`npm ${args[0]} failed`);
    }
  };
  for (const pkg of missing) {
    const tarball = pack(pkg);
    await withOtp([
      "publish",
      tarball,
      "--access",
      "public",
      "--provenance=false",
    ]);
    await withOtp([
      "trust",
      "github",
      pkg.name,
      "--file",
      WORKFLOW,
      "--repository",
      REPOSITORY,
      "--environment",
      ENVIRONMENT,
      "--allow-publish",
      "--yes",
    ]);
    console.log(
      `${pkg.name}@${pkg.version} published; trusted publisher attached`,
    );
  }
  rl.close();
} else {
  fail([
    `unknown command ${command ?? "(none)"}; use check, publish, or bootstrap`,
  ]);
}

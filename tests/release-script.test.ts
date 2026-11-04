import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../scripts/release.mjs", import.meta.url),
);
const run = (...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

interface ExternalCall {
  command: string;
  args: string[];
}

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

// Run the real release CLI in an isolated workspace. Only the external npm and
// pnpm commands are replaced: record their arguments and return pack metadata.
const releaseFixture = (version: string) => {
  const output = join(dirname(script), "../.release");
  mkdirSync(output, { recursive: true });
  const root = mkdtempSync(join(output, "release-test-"));
  fixtures.push(root);
  mkdirSync(join(root, "scripts"));
  copyFileSync(script, join(root, "scripts/release.mjs"));
  for (const name of ["matter", "loop"]) {
    const dir = join(root, "packages", name);
    mkdirSync(dir, { recursive: true });
    const manifest = JSON.parse(
      readFileSync(
        join(dirname(script), "../packages", name, "package.json"),
        "utf8",
      ),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ ...manifest, version }),
    );
  }
  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "calls.jsonl");
  for (const command of ["npm", "pnpm"]) {
    const executable = join(bin, command);
    writeFileSync(
      executable,
      `#!${process.execPath}
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify({ command: ${JSON.stringify(command)}, args }) + "\\n");
if (${JSON.stringify(command)} === "pnpm" && args[0] === "pack") {
  console.log(JSON.stringify({ filename: process.cwd() + "/package.tgz" }));
} else if (${JSON.stringify(command)} !== "npm" || !["view", "publish"].includes(args[0])) {
  process.exit(2);
}
`,
    );
    chmodSync(executable, 0o755);
  }
  return {
    run: (...args: string[]) =>
      spawnSync(
        process.execPath,
        [join(root, "scripts/release.mjs"), ...args],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            GITHUB_REF_NAME: `v${version}`,
            RELEASE_TEST_LOG: log,
          },
        },
      ),
    calls: (): ExternalCall[] =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [],
  };
};

const publishCalls = (fixture: ReturnType<typeof releaseFixture>) =>
  fixture
    .calls()
    .filter((call) => call.command === "npm" && call.args[0] === "publish");

describe("scripts/release.mjs", () => {
  it("accepts the workspace: one version and complete publish metadata", () => {
    const result = run("check");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /^13 packages at \d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\n$/,
    );
  });

  it("refuses a tag that does not match the package versions", () => {
    const result = run("check", "--tag", "v999.0.0");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@openma/matter@");
    expect(result.stderr).toContain("@openma/matter-gitlab@");
    expect(result.stderr).toContain("does not match tag v999.0.0");
  });

  it("refuses an unknown command", () => {
    const result = run("ship");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown command ship");
  });

  // Dropping --tag from npm publish would send this prerelease to latest.
  it("publishes every prerelease tarball with the explicit non-latest dist-tag", () => {
    const fixture = releaseFixture("0.2.9-file-resources.0");
    const result = fixture.run("publish", "--dist-tag", "file-resources");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const calls = publishCalls(fixture);
    expect(calls).toHaveLength(2);
    for (const { args } of calls) {
      expect(args.slice(2)).toEqual([
        "--access",
        "public",
        "--provenance",
        "--tag",
        "file-resources",
      ]);
      expect(args).not.toContain("latest");
    }
    expect(
      fixture
        .calls()
        .filter((call) => call.command === "pnpm")
        .map((call) => call.args),
    ).toEqual([
      ["pack", "--pack-destination", expect.any(String), "--json"],
      ["pack", "--pack-destination", expect.any(String), "--json"],
    ]);
  });

  // Removing either guard must fail before even contacting the registry.
  it.each([[], ["--dist-tag", "latest"]])(
    "refuses prerelease publishing without an explicit non-latest tag: %j",
    (...args) => {
      const fixture = releaseFixture("0.2.9-file-resources.0");
      const result = fixture.run("publish", ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("prerelease");
      expect(fixture.calls()).toEqual([]);
    },
  );

  it("cannot bypass prerelease tag safety through bootstrap", () => {
    const fixture = releaseFixture("0.2.9-file-resources.0");
    const result = fixture.run("bootstrap", "--dry-run");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("prerelease");
    expect(fixture.calls()).toEqual([]);
  });

  // Treating a malformed/missing/duplicate option as a default could publish to latest.
  it.each([
    ["--dist-tag"],
    ["--dist-tag=next"],
    ["--dist-tag", ""],
    ["--dist-tag", "--access"],
    ["--dist-tag", "1.0.0"],
    ["--dist-tag", "v1"],
    ["--dist-tag", "Latest"],
    ["--dist-tag", "file resources"],
    ["--dist-tag", "file/resources"],
    ["--dist-tag", "file-resources;echo unsafe"],
    ["--dist-tag", "file-resources", "--dist-tag", "next"],
  ])(
    "refuses an invalid dist-tag before any external command: %j",
    (...args) => {
      const fixture = releaseFixture("0.2.9");
      const result = fixture.run("publish", ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("dist-tag");
      expect(fixture.calls()).toEqual([]);
    },
  );

  it("keeps stable releases on latest by default", () => {
    const fixture = releaseFixture("0.2.9");
    const result = fixture.run("publish");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const calls = publishCalls(fixture);
    expect(calls).toHaveLength(2);
    for (const { args } of calls) {
      expect(args.slice(2)).toEqual([
        "--access",
        "public",
        "--provenance",
        "--tag",
        "latest",
      ]);
    }
  });
});

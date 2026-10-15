import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../scripts/release.mjs", import.meta.url),
);
const run = (...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

describe("scripts/release.mjs", () => {
  it("accepts the workspace: one version and complete publish metadata", () => {
    const result = run("check");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^2 packages at \d+\.\d+\.\d+\n$/);
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
});

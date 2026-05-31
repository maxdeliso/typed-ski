import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  cleanupTempWorkspace,
  createTempWorkspace,
  jsRoot,
} from "../util/tripcHarness.ts";

const improvizeScriptPath = join(jsRoot, "bin", "improvize.js");

function runImprovize(args: string[], cwd?: string) {
  return spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", improvizeScriptPath, ...args],
    {
      cwd,
      encoding: "utf8",
    },
  );
}

describe("improvize CLI", () => {
  it("prints help and version", () => {
    const help = runImprovize(["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /improvize/);
    assert.match(help.stdout, /format/);
    assert.match(help.stdout, /lint/);
    assert.match(help.stdout, /--version/);
    assert.match(help.stdout, /--verbose/);

    const version = runImprovize(["--version"]);
    assert.equal(version.status, 0);
    assert.match(version.stdout.trim(), /^improvize v\d+\.\d+\.\d+$/);
  });

  it("checks formatting and writes formatted files", async () => {
    const workspace = await createTempWorkspace("typed-ski-improvize-cli-");
    try {
      const file = join(workspace, "Main.trip");
      await writeFile(file, "module M\npoly main = #A=>\\x:A=>x\n", "utf8");

      const check = runImprovize(["format", "--check", file]);
      assert.equal(check.status, 1);
      assert.match(check.stdout, /needs formatting/);

      const write = runImprovize(["format", "--write", file]);
      assert.equal(write.status, 0, write.stderr);
      const formatted = await readFile(file, "utf8");
      assert.match(formatted, /poly main =\n  #A => \\x : A => x\n/);

      const recheck = runImprovize(["format", "--check", file]);
      assert.equal(recheck.status, 0);

      const stdoutFormat = runImprovize(["format", file]);
      assert.equal(stdoutFormat.status, 0, stdoutFormat.stderr);
      assert.equal(stdoutFormat.stdout, formatted);
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  it("reports lint findings and applies fixes", async () => {
    const workspace = await createTempWorkspace("typed-ski-improvize-lint-");
    try {
      const file = join(workspace, "Main.trip");
      await writeFile(file, "module M\npoly main = 7\n", "utf8");

      const lint = runImprovize(["lint", file]);
      assert.equal(lint.status, 1);
      assert.match(lint.stdout, /trip-u8-literal/);

      const fixed = runImprovize(["lint", "--fix", file]);
      assert.equal(fixed.status, 0, fixed.stderr);
      const content = await readFile(file, "utf8");
      assert.match(content, /#u8\(7\)/);
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  it("keeps lint --fix nonzero when diagnostics remain", async () => {
    const workspace = await createTempWorkspace("typed-ski-improvize-lint-");
    try {
      const file = join(workspace, "Main.trip");
      await writeFile(
        file,
        "module M\nimport Prelude if\npoly main = if [A] true t f\n",
        "utf8",
      );

      const fixed = runImprovize(["lint", "--fix", file]);
      assert.equal(fixed.status, 1);
      assert.match(fixed.stdout, /trip-if-constant/);
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });
});

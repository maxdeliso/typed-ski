import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

describe("Bootstrapped Lowering Pipeline", () => {
  const libDir = join(PROJECT_ROOT, "lib");
  const compilerLibDir = join(libDir, "compiler");

  const files = [
    join(libDir, "prelude.trip"),
    join(libDir, "nat.trip"),
    join(libDir, "bin.trip"),
    join(libDir, "avl.trip"),
    join(compilerLibDir, "lexer.trip"),
    join(compilerLibDir, "parser.trip"),
    join(compilerLibDir, "core.trip"),
    join(compilerLibDir, "dataEnv.trip"),
    join(compilerLibDir, "coreToLower.trip"),
    join(compilerLibDir, "unparse.trip"),
    join(compilerLibDir, "lowering.trip"),
    join(compilerLibDir, "bridge.trip"),
    join(compilerLibDir, "index.trip"),
  ];

  it("link all compiler modules and run a simple compilation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "typed-ski-bootstrapped-"));
    try {
      // 1. Compile each module to .tripc in the temp directory
      const tripcFiles: string[] = [];
      for (const file of files) {
        const tripcFile = join(
          tempDir,
          basename(file).replace(".trip", ".tripc"),
        );
        const { status: code, stderr } = spawnSync(
          process.execPath,
          [
            "--disable-warning=ExperimentalWarning",
            "--experimental-transform-types",
            join(PROJECT_ROOT, "bin", "tripc.ts"),
            file,
            tripcFile,
          ],
          { cwd: PROJECT_ROOT, maxBuffer: 32 * 1024 * 1024 },
        );

        if (code !== 0) {
          const err = stderr.toString();
          throw new Error(`Failed to compile ${file}: ${err}`);
        }
        tripcFiles.push(tripcFile);
      }

      // 2. Link all modules to an SKI expression
      const {
        stdout,
        status: code,
        stderr,
      } = spawnSync(
        process.execPath,
        [
          "--disable-warning=ExperimentalWarning",
          "--experimental-transform-types",
          join(PROJECT_ROOT, "bin", "tripc.ts"),
          "--link",
          ...tripcFiles,
        ],
        { cwd: PROJECT_ROOT, maxBuffer: 32 * 1024 * 1024 },
      );

      if (code !== 0) {
        const err = stderr.toString();
        throw new Error(`Failed to link: ${err}`);
      }

      const skiOutput = stdout.toString().trim();
      assert.ok(skiOutput.length > 0);
    } finally {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

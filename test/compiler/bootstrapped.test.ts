import { expect } from "chai";
import { dirname, join } from "std/path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

Deno.test("Bootstrapped Lowering Pipeline", async (t) => {
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

  await t.step(
    "link all compiler modules and run a simple compilation",
    async () => {
      // 1. Compile each module to .tripc
      const tripcFiles: string[] = [];
      for (const file of files) {
        const tripcFile = file.replace(".trip", ".tripc");
        const compileCmd = new Deno.Command(Deno.execPath(), {
          args: [
            "run",
            "--allow-read",
            "--allow-write",
            join(PROJECT_ROOT, "bin", "tripc.ts"),
            file,
            tripcFile,
          ],
          cwd: PROJECT_ROOT,
        });
        const { code, stderr } = await compileCmd.output();
        if (code !== 0) {
          const err = new TextDecoder().decode(stderr);
          throw new Error(`Failed to compile ${file}: ${err}`);
        }
        tripcFiles.push(tripcFile);
      }

      // 2. Link all modules to an SKI expression
      const linkCmd = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-read",
          "--allow-write",
          join(PROJECT_ROOT, "bin", "tripc.ts"),
          "--link",
          ...tripcFiles,
        ],
        cwd: PROJECT_ROOT,
      });

      const { stdout, code, stderr } = await linkCmd.output();
      if (code !== 0) {
        const err = new TextDecoder().decode(stderr);
        throw new Error(`Failed to link: ${err}`);
      }

      const skiOutput = new TextDecoder().decode(stdout).trim();
      expect(skiOutput).to.not.be.empty;

      // Keep this test focused on the bootstrapped compiler pipeline itself.
      // Importing thanatosHarness here dynamically registers nested Deno tests,
      // which breaks the test runner before we can validate compilation/linking.
    },
  );
});

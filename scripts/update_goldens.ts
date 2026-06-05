import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { workspaceRoot } from "../lib/shared/workspaceRoot.ts";
import { compilerTripModuleSourcePath } from "../lib/compiler/bootstrapModules.ts";
import { compileMiniCoreModules } from "../lib/minicore/fromTrip.ts";
import { evaluateMiniCore } from "../lib/minicore/evaluator.ts";
import type { Value } from "../lib/minicore/ast.ts";
import {
  buildMiniVerifyHarnessSource,
  MINI_VERIFY_MODULE_NAMES,
} from "../test/compiler/minicoreAnfHarness.ts";
import { realBootstrapBundle } from "../test/compiler/llvm/bundleV1.test.ts";
import { summarizeTripBundleV1ParsedModules } from "../lib/compiler/index.ts";

function valueToBytes(value: Value): number[] {
  const bytes: number[] = [];
  let cur: Value = value;
  while (cur.kind === "con" && cur.fields.length === 2) {
    const head = cur.fields[0];
    const tail = cur.fields[1];
    if (head === undefined || tail === undefined || head.kind !== "lit") {
      throw new Error(`expected u8 list head, got ${JSON.stringify(head)}`);
    }
    const literal = head.value;
    if (literal.kind !== "u8") {
      throw new Error(`expected u8 list head, got ${JSON.stringify(head)}`);
    }
    bytes.push(literal.value);
    cur = tail;
  }
  if (cur.kind !== "con" || cur.fields.length !== 0) {
    throw new Error(`expected nil terminator, got ${JSON.stringify(cur)}`);
  }
  return bytes;
}

async function main() {
  console.log("Regenerating goldens...");

  // 1. Update minicoreAnf.golden.txt
  const minicoreAnfGoldenPath = join(
    workspaceRoot,
    "test",
    "compiler",
    "inputs",
    "minicoreAnf.golden.txt",
  );
  console.log(`Generating minicoreAnf golden at ${minicoreAnfGoldenPath}...`);
  const modules: Array<{ name: string; source: string }> = await Promise.all(
    MINI_VERIFY_MODULE_NAMES.map(async (name) => ({
      name,
      source: await readFile(compilerTripModuleSourcePath(name), "utf8"),
    })),
  );
  modules.push({
    name: "Verify",
    source: buildMiniVerifyHarnessSource("list"),
  });
  const program = compileMiniCoreModules(modules, "Verify");
  const result = evaluateMiniCore(program);
  const minicoreAnfGoldenContent = Buffer.from(
    valueToBytes(result.value),
  ).toString("utf8");
  await writeFile(minicoreAnfGoldenPath, minicoreAnfGoldenContent, "utf8");
  console.log("Successfully wrote minicoreAnf.golden.txt.");

  // 2. Update llvm/fixtures parsed module summaries
  const fixtureDir = join(
    workspaceRoot,
    "test",
    "compiler",
    "llvm",
    "fixtures",
  );

  const parseSummaryCases = [
    {
      modules: ["Prelude"],
      fileName: "bootstrap-parse-summary-prelude.txt",
    },
    {
      modules: ["Prelude", "Bin", "Lexer"],
      fileName: "bootstrap-parse-summary-prelude-bin-lexer.txt",
    },
    {
      modules: ["Prelude", "Bin", "Lexer", "Parser"],
      fileName: "bootstrap-parse-summary-prelude-bin-lexer-parser.txt",
    },
  ];

  for (const { modules, fileName } of parseSummaryCases) {
    const filePath = join(fixtureDir, fileName);
    console.log(
      `Generating parsed module summary golden for [${modules.join(", ")}] at ${filePath}...`,
    );
    const bundle = realBootstrapBundle(modules);
    const summary = summarizeTripBundleV1ParsedModules(bundle);
    await writeFile(filePath, summary, "utf8");
    console.log(`Successfully wrote ${fileName}.`);
  }

  console.log("All goldens updated successfully!");
}

main().catch((err) => {
  console.error("Error updating goldens:", err);
  process.exit(1);
});

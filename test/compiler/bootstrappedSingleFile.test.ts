import { describe, it, before, after } from "../util/test_shim.ts";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import {
  combineTopoDagWires,
  countTopoDagWireRecords,
  toTopoDagWire,
} from "../../lib/ski/topoDagWire.ts";
import {
  closeBatchThanatosSessions,
  thanatosAvailable,
  withBatchThanatosSession,
} from "../thanatosHarness.ts";
import { apply } from "../../lib/ski/expression.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { lowerToSKI } from "../../lib/linker/moduleLinker.ts";
import type { SKIExpression } from "../../lib/ski/expression.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");

async function compileAndLinkCompiler() {
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
    join(compilerLibDir, "telemetry.trip"),
  ];

  const modules = await Promise.all(
    files.map(async (file) => {
      const content = await readFile(file, "utf8");
      const object = compileToObjectFile(content);
      return { name: object.module, object };
    }),
  );

  const { createProgramSpace, resolveCrossModuleDependencies, loadModule } =
    await import("../../lib/linker/moduleLinker.ts");

  const loadedModules = modules.map(({ name, object }) =>
    loadModule(object, name),
  );
  let ps = createProgramSpace(loadedModules);
  ps = resolveCrossModuleDependencies(ps);

  return ps;
}

function encodeListU8(
  bytes: Uint8Array,
  nil: SKIExpression,
  cons: SKIExpression,
): SKIExpression {
  let acc = nil;
  for (let i = bytes.length - 1; i >= 0; i--) {
    const byte = bytes[i];
    if (byte === undefined) continue;
    acc = apply(apply(cons, { kind: "u8", value: byte }), acc);
  }
  return acc;
}

const PHASE_BUDGETS: Record<string, number> = {
  phase1: 1 << 16,
  phase2: 1 << 18,
  phase3: 1 << 20,
  phase4: 1 << 22,
};

const PHASES = ["phase1", "phase2", "phase3", "phase4"];

describe("Bootstrapped Single-File Compiler Telemetry", () => {
  for (const phaseName of PHASES) {
    it(
      `Bootstrapped Phase: ${phaseName}`,
      { skip: !thanatosAvailable() },
      async () => {
        const ps = await compileAndLinkCompiler();
        await withBatchThanatosSession(async (session) => {
          const nil = parseSKI(lowerToSKI(ps.terms.get("Prelude.nil")!));
          const cons = parseSKI(lowerToSKI(ps.terms.get("Prelude.cons")!));

          const getPhaseTerm = (name: string) =>
            parseSKI(lowerToSKI(ps.terms.get(`Telemetry.${name}`)!));

          const filePath = join(
            PROJECT_ROOT,
            "test",
            "compiler",
            "inputs",
            "small.trip",
          );
          const sourceText = await readFile(filePath, "utf8");
          const sourceBytes = new TextEncoder().encode(sourceText);

          let currentDag = toTopoDagWire(encodeListU8(sourceBytes, nil, cons));

          // Run preceding phases to get to the current phase's input DAG
          for (const p of PHASES) {
            await session.reset();
            const phaseTerm = getPhaseTerm(p);
            const phaseDag = toTopoDagWire(phaseTerm);
            const combinedDag = combineTopoDagWires(phaseDag, currentDag);

            const resultDag = await session.reduceDag(combinedDag);
            const uniqueNodeCount = countTopoDagWireRecords(resultDag);

            if (p === phaseName) {
              const budget = PHASE_BUDGETS[p];
              if (budget !== undefined && uniqueNodeCount > budget) {
                throw new Error(
                  `[bootstrapped budget exceeded] phase: ${p}, unique_nodes: ${uniqueNodeCount}, budget: ${budget}`,
                );
              }
              break;
            }
            currentDag = resultDag;
          }
        });
      },
    );
  }

  after(async () => {
    if (thanatosAvailable()) {
      await closeBatchThanatosSessions();
    }
  });
});

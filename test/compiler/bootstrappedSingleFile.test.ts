import { test } from "node:test";
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

type PhaseMetric = {
  phase: string;
  uniqueNodeCount: number;
  totalNodeCount: number;
  totalConsAllocs: number;
  totalContAllocs: number;
  totalSuspAllocs: number;
  duplicateLostAllocs: number;
  hashconsHits: number;
  hashconsMisses: number;
  totalSteps: number;
  arenaTop: number;
  elapsedMs: number;
};

const PHASE_BUDGETS: Record<string, number> = {
  phase1: 1 << 16,
  phase2: 1 << 18,
  phase3: 1 << 20,
  phase4: 1 << 22,
};

test(
  "Bootstrapped Single-File Compiler Telemetry",
  {
    skip: !thanatosAvailable(),
  },
  async (t) => {
    try {
      const ps = await compileAndLinkCompiler();
      await withBatchThanatosSession(async (session) => {
        const nil = parseSKI(lowerToSKI(ps.terms.get("Prelude.nil")!));
        const cons = parseSKI(lowerToSKI(ps.terms.get("Prelude.cons")!));

        const phases = [
          {
            name: "phase1",
            term: parseSKI(lowerToSKI(ps.terms.get("Telemetry.phase1")!)),
          },
          {
            name: "phase2",
            term: parseSKI(lowerToSKI(ps.terms.get("Telemetry.phase2")!)),
          },
          {
            name: "phase3",
            term: parseSKI(lowerToSKI(ps.terms.get("Telemetry.phase3")!)),
          },
          {
            name: "phase4",
            term: parseSKI(lowerToSKI(ps.terms.get("Telemetry.phase4")!)),
          },
        ];

        const runTestForFile = async (filePath: string) => {
          const sourceText = await readFile(filePath, "utf8");
          const sourceBytes = new TextEncoder().encode(sourceText);
          let currentDag = toTopoDagWire(encodeListU8(sourceBytes, nil, cons));

          const metrics: PhaseMetric[] = [];

          await session.reset();

          for (const phase of phases) {
            await t.test(`Phase: ${phase.name}`, async () => {
              await session.reset();
              const startTime = performance.now();

              const phaseDag = toTopoDagWire(phase.term);
              const combinedDag = combineTopoDagWires(phaseDag, currentDag);

              let resultDag;
              try {
                resultDag = await session.reduceDag(combinedDag);
              } catch (e) {
                const endTime = performance.now();
                const elapsedMs = endTime - startTime;
                console.error(
                  `\n[FATAL] Phase ${phase.name} failed after ${elapsedMs.toFixed(
                    2,
                  )}ms`,
                );
                console.error(`Error: ${(e as Error).message}`);
                throw e;
              }

              const endTime = performance.now();
              const statsLine = await session.stats();
              const topMatch = statsLine.match(/top=(\d+)/);
              const nodesMatch = statsLine.match(/total_nodes=(\d+)/);
              const stepsMatch = statsLine.match(/total_steps=(\d+)/);
              const consMatch = statsLine.match(/total_cons_allocs=(\d+)/);
              const contMatch = statsLine.match(/total_cont_allocs=(\d+)/);
              const suspMatch = statsLine.match(/total_susp_allocs=(\d+)/);
              const duplicateMatch = statsLine.match(
                /duplicate_lost_allocs=(\d+)/,
              );
              const hashconsHitsMatch = statsLine.match(/hashcons_hits=(\d+)/);
              const hashconsMissesMatch = statsLine.match(
                /hashcons_misses=(\d+)/,
              );

              const arenaTop = topMatch ? parseInt(topMatch[1]!, 10) : 0;
              const totalNodeCount = nodesMatch
                ? parseInt(nodesMatch[1]!, 10)
                : 0;
              const totalSteps = stepsMatch ? parseInt(stepsMatch[1]!, 10) : 0;
              const totalConsAllocs = consMatch
                ? parseInt(consMatch[1]!, 10)
                : 0;
              const totalContAllocs = contMatch
                ? parseInt(contMatch[1]!, 10)
                : 0;
              const totalSuspAllocs = suspMatch
                ? parseInt(suspMatch[1]!, 10)
                : 0;
              const duplicateLostAllocs = duplicateMatch
                ? parseInt(duplicateMatch[1]!, 10)
                : 0;
              const hashconsHits = hashconsHitsMatch
                ? parseInt(hashconsHitsMatch[1]!, 10)
                : 0;
              const hashconsMisses = hashconsMissesMatch
                ? parseInt(hashconsMissesMatch[1]!, 10)
                : 0;

              const uniqueNodeCount = countTopoDagRecords(resultDag);
              const elapsedMs = endTime - startTime;

              metrics.push({
                phase: phase.name,
                uniqueNodeCount,
                totalNodeCount,
                totalConsAllocs,
                totalContAllocs,
                totalSuspAllocs,
                duplicateLostAllocs,
                hashconsHits,
                hashconsMisses,
                totalSteps,
                arenaTop,
                elapsedMs,
              });

              const duplicationFactor =
                uniqueNodeCount > 0
                  ? (totalNodeCount / uniqueNodeCount).toFixed(2)
                  : "0.00";
              const hashconsHitRate =
                hashconsHits + hashconsMisses > 0
                  ? (
                      (hashconsHits / (hashconsHits + hashconsMisses)) *
                      100
                    ).toFixed(2)
                  : "0.00";
              console.log(
                `[${phase.name}] Unique: ${uniqueNodeCount}, Total: ${totalNodeCount}, Duplication: ${duplicationFactor}x, Cons: ${totalConsAllocs}, Cont: ${totalContAllocs}, Susp: ${totalSuspAllocs}, DupLost: ${duplicateLostAllocs}, HashHits: ${hashconsHits}, HashMisses: ${hashconsMisses}, HitRate: ${hashconsHitRate}%, Steps: ${totalSteps}, Time: ${elapsedMs.toFixed(
                  2,
                )}ms`,
              );

              const budget = PHASE_BUDGETS[phase.name];
              if (budget !== undefined && uniqueNodeCount > budget) {
                throw new Error(`[bootstrapped budget exceeded]
file: ${filePath}
phase: ${phase.name}
unique_nodes: ${uniqueNodeCount}
budget: ${budget}
elapsed_ms: ${elapsedMs.toFixed(2)}`);
              }

              currentDag = resultDag;
              await session.reset();
            });
          }

          return metrics;
        };

        await runTestForFile(
          join(PROJECT_ROOT, "test", "compiler", "inputs", "small.trip"),
        );
      });
    } finally {
      await closeBatchThanatosSessions();
    }
  },
);

function countTopoDagRecords(dag: string): number {
  return countTopoDagWireRecords(dag);
}

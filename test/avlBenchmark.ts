import { performance } from "node:perf_hooks";
import { strictEqual as assertEquals } from "node:assert/strict";
import {
  compileToObjectFileString,
  deserializeTripCObject,
} from "../lib/compiler/index.ts";
import { parseSKI } from "../lib/parser/ski.ts";
import { UnChurchNumber } from "../lib/ski/church.ts";
import { fromTopoDagWire, toTopoDagWire } from "../lib/ski/topoDagWire.ts";
import {
  closeBatchThanatosSessions,
  passthroughEvaluator,
  thanatosAvailable,
  withBatchThanatosSession,
} from "./thanatosHarness.ts";
import {
  AVL_CASES,
  getAvlBuiltinObjectsCached,
  linkAvlModulesWithBuiltins,
} from "./avlHarness.ts";

type ParsedThanatosStats = Record<string, string>;

type AvlBenchmarkResult = {
  name: string;
  moduleName: string;
  expected: string;
  actual: string;
  sourceBytes: number;
  serializedBytes: number;
  skiChars: number;
  astNodes: number;
  compileMs: number;
  deserializeMs: number;
  linkMs: number;
  parseMs: number;
  dagEncodeMs: number;
  reduceMs: number;
  statsMs: number;
  decodeResultMs: number;
  wallMs: number;
  thanatosStats: ParsedThanatosStats;
};

function parseThanatosStats(line: string): ParsedThanatosStats {
  if (!line.startsWith("OK ")) {
    throw new Error(`Expected OK stats line, got: ${line}`);
  }

  const stats: ParsedThanatosStats = {};
  for (const field of line.slice(3).trim().split(/\s+/)) {
    const equalsIndex = field.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    stats[field.slice(0, equalsIndex)] = field.slice(equalsIndex + 1);
  }
  return stats;
}

function countSkiNodes(expr: ReturnType<typeof parseSKI>): number {
  if (expr.kind === "terminal" || expr.kind === "u8") {
    return 1;
  }
  return 1 + countSkiNodes(expr.lft) + countSkiNodes(expr.rgt);
}

function formatMs(value: number): string {
  return value.toFixed(3);
}

function formatRatio(
  numeratorText: string | undefined,
  denominatorText: string | undefined,
): string {
  if (!numeratorText || !denominatorText) {
    return "n/a";
  }
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator === 0
  ) {
    return "n/a";
  }
  return (numerator / denominator).toFixed(4);
}

async function benchmarkCase(
  name: string,
  moduleName: string,
  loadSource: () => Promise<string>,
  expected: bigint,
): Promise<AvlBenchmarkResult> {
  const wallStart = performance.now();
  const builtins = await getAvlBuiltinObjectsCached();

  const source = await loadSource();

  const compileStart = performance.now();
  const serialized = compileToObjectFileString(source);
  const compileEnd = performance.now();

  const deserializeStart = performance.now();
  const testObject = deserializeTripCObject(serialized);
  const deserializeEnd = performance.now();

  const linkStart = performance.now();
  const skiExpression = linkAvlModulesWithBuiltins(
    moduleName,
    testObject,
    builtins,
  );
  const linkEnd = performance.now();

  const parseStart = performance.now();
  const expr = parseSKI(skiExpression);
  const parseEnd = performance.now();

  const dagEncodeStart = performance.now();
  const dag = toTopoDagWire(expr);
  const dagEncodeEnd = performance.now();

  let actual = 0n;
  let statsLine = "";
  let statsMs = 0;
  let decodeResultMs = 0;
  let reduceMs = 0;
  await withBatchThanatosSession(async (session) => {
    const reduceStart = performance.now();
    const resultDag = await session.reduceDag(dag);
    const reduceEnd = performance.now();
    reduceMs = reduceEnd - reduceStart;

    const statsStart = performance.now();
    statsLine = await session.stats();
    const statsEnd = performance.now();
    statsMs = statsEnd - statsStart;

    const decodeStart = performance.now();
    actual = await UnChurchNumber(
      fromTopoDagWire(resultDag),
      passthroughEvaluator,
    );
    const decodeEnd = performance.now();
    decodeResultMs = decodeEnd - decodeStart;

    assertEquals(
      actual,
      expected,
      `benchmark result mismatch for ${name}: expected ${expected}, got ${actual}`,
    );
  });
  const wallEnd = performance.now();

  return {
    name,
    moduleName,
    expected: expected.toString(),
    actual: actual.toString(),
    sourceBytes: Buffer.byteLength(source, "utf8"),
    serializedBytes: Buffer.byteLength(serialized, "utf8"),
    skiChars: skiExpression.length,
    astNodes: countSkiNodes(expr),
    compileMs: compileEnd - compileStart,
    deserializeMs: deserializeEnd - deserializeStart,
    linkMs: linkEnd - linkStart,
    parseMs: parseEnd - parseStart,
    dagEncodeMs: dagEncodeEnd - dagEncodeStart,
    reduceMs,
    statsMs,
    decodeResultMs,
    wallMs: wallEnd - wallStart,
    thanatosStats: parseThanatosStats(statsLine),
  };
}

async function main(): Promise<void> {
  if (!thanatosAvailable()) {
    throw new Error("thanatos binary not found");
  }

  const emitJson = process.argv.includes("--json");
  const results: AvlBenchmarkResult[] = [];

  try {
    for (const testCase of AVL_CASES) {
      results.push(
        await benchmarkCase(
          testCase.name,
          testCase.moduleName,
          testCase.loadSource,
          testCase.expected,
        ),
      );
    }
  } finally {
    await closeBatchThanatosSessions();
  }

  if (emitJson) {
    console.log(JSON.stringify({ cases: results }, null, 2));
    return;
  }

  console.table(
    results.map((result) => ({
      case: result.name,
      compileMs: formatMs(result.compileMs),
      linkMs: formatMs(result.linkMs),
      parseMs: formatMs(result.parseMs),
      dagEncodeMs: formatMs(result.dagEncodeMs),
      reduceMs: formatMs(result.reduceMs),
      statsMs: formatMs(result.statsMs),
      decodeResultMs: formatMs(result.decodeResultMs),
      wallMs: formatMs(result.wallMs),
      skiChars: result.skiChars,
      astNodes: result.astNodes,
      totalSteps: result.thanatosStats.total_steps ?? "n/a",
      totalNodes: result.thanatosStats.total_nodes ?? "n/a",
      hashconsHits: result.thanatosStats.hashcons_hits ?? "n/a",
      hashconsMisses: result.thanatosStats.hashcons_misses ?? "n/a",
      bulkFusionChecks: result.thanatosStats.bulk_fusion_checks ?? "n/a",
      bulkFusionCandidates:
        result.thanatosStats.bulk_fusion_candidates ?? "n/a",
      bulkFusionHits: result.thanatosStats.bulk_fusion_hits ?? "n/a",
      bulkFusionHitRate: formatRatio(
        result.thanatosStats.bulk_fusion_hits,
        result.thanatosStats.bulk_fusion_checks,
      ),
      bulkFusionCandidateHitRate: formatRatio(
        result.thanatosStats.bulk_fusion_hits,
        result.thanatosStats.bulk_fusion_candidates,
      ),
    })),
  );
}

await main();

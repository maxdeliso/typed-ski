import { assert } from "std/assert";
import { dirname, join } from "std/path";
import { fileURLToPath } from "node:url";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import type { TripCObject } from "../../lib/compiler/objectFile.ts";
import {
  fromDagWire,
  readTraceDumpJson,
  thanatosAvailable,
  ThanatosSession,
  toDagWire,
  waitForTraceDump,
} from "../thanatosHarness.test.ts";
import { apply } from "../../lib/ski/expression.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { lowerToSKI } from "../../lib/linker/moduleLinker.ts";
import type { SKIExpression } from "../../lib/ski/expression.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const BOOTSTRAP_TELEMETRY_TAIL_FILE = join(
  PROJECT_ROOT,
  "test",
  "compiler",
  "inputs",
  "bootstrapTelemetryTail.trip",
);

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

  const modules = await Promise.all(files.map(async (file) => {
    const content = await Deno.readTextFile(file);
    const object = compileToObjectFile(content);
    return { name: object.module, object };
  }));

  const { createProgramSpace, resolveCrossModuleDependencies, loadModule } =
    await import("../../lib/linker/moduleLinker.ts");

  const loadedModules = modules.map(({ name, object }) =>
    loadModule(object, name)
  );
  let ps = createProgramSpace(loadedModules);
  ps = resolveCrossModuleDependencies(ps);

  return {
    ps,
    moduleObjects: new Map(
      modules.map(({ name, object }) => [name, object] as const),
    ),
  };
}

async function compileAndLinkBootstrapTelemetryCompiler() {
  const compiler = await compileAndLinkCompiler();
  const telemetryTailSource = await Deno.readTextFile(
    BOOTSTRAP_TELEMETRY_TAIL_FILE,
  );
  const telemetryTailObject = compileToObjectFile(telemetryTailSource, {
    importedModules: [...compiler.moduleObjects.values()],
  });

  const { createProgramSpace, resolveCrossModuleDependencies, loadModule } =
    await import("../../lib/linker/moduleLinker.ts");

  const loadedModules = [
    ...[...compiler.moduleObjects.entries()].map(([name, object]) =>
      loadModule(object, name)
    ),
    loadModule(telemetryTailObject, telemetryTailObject.module),
  ];
  let ps = createProgramSpace(loadedModules);
  ps = resolveCrossModuleDependencies(ps);

  return {
    ps,
    moduleObjects: new Map<string, TripCObject>([
      ...compiler.moduleObjects.entries(),
      [telemetryTailObject.module, telemetryTailObject],
    ]),
  };
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
  timedOut: boolean;
};

type Phase6ShapeMetric = {
  appNodes: bigint;
  termNodes: bigint;
  byteLiterals: bigint;
  maxDepth: bigint;
  outputBytes: bigint;
  parenBytes: bigint;
  spaceBytes: bigint;
};

const PHASE_BUDGETS: Record<string, number> = {
  phase1: 1 << 16,
  phase2: 1 << 18,
  phase3: 1 << 20,
  phase4: 1 << 22,
  phase5: 1 << 22,
  phase6: 1 << 24,
};

const TRACE_PHASE_TOKENIZE = 3;
const TRACE_PHASE_PARSE = 4;
const TRACE_PHASE_ELABORATE = 5;
const TRACE_PHASE_LOWER = 6;
const TRACE_PHASE_FIND_MAIN = 7;
const TRACE_PHASE_UNPARSE = 8;

const TRACE_SOURCE_TELEMETRY_PHASE1 = 3001;
const TRACE_SOURCE_TELEMETRY_PHASE2 = 3002;
const TRACE_SOURCE_TELEMETRY_PHASE3 = 3003;
const TRACE_SOURCE_TELEMETRY_PHASE4 = 3004;
const TRACE_SOURCE_TELEMETRY_PHASE5 = 3005;
const TRACE_SOURCE_TELEMETRY_PHASE6 = 3006;
const TRACE_SOURCE_COMPILER_COMPILE_TO_COMB = 3007;

const TRACE_PROC_TELEMETRY_PHASE1 = 4001;
const TRACE_PROC_TELEMETRY_PHASE2 = 4002;
const TRACE_PROC_TELEMETRY_PHASE3 = 4003;
const TRACE_PROC_TELEMETRY_PHASE4 = 4004;
const TRACE_PROC_TELEMETRY_PHASE5 = 4005;
const TRACE_PROC_TELEMETRY_PHASE6 = 4006;
const TRACE_PROC_COMPILER_COMPILE_TO_COMB = 4007;
const PHASE_TIMEOUT_MS = 30000;

type CompilerPhaseTerms = {
  phase1: SKIExpression;
  phase2: SKIExpression;
  phase3: SKIExpression;
  phase4: SKIExpression;
  phase5: SKIExpression;
  phase6: SKIExpression;
  phase6TextProfile: SKIExpression;
  phase6TextProfileOutputBytes: SKIExpression;
  phase6TextProfileParenBytes: SKIExpression;
  phase6TextProfileSpaceBytes: SKIExpression;
  phase6TextProfileByteLiterals: SKIExpression;
  phase6TextProfileMaxDepth: SKIExpression;
  nil: SKIExpression;
  cons: SKIExpression;
};

type TraceDump = {
  epoch: number;
  symbols: {
    procs: Array<{ id: number; name: string }>;
    sources: Array<{ id: number; file: string }>;
  };
  workers: Array<{
    state: string;
    phase_id: number;
    proc_id: number;
    source_id: number;
    recent_events: Array<{
      phase_id: number;
      proc_id: number;
      source_id: number;
    }>;
  }>;
};

function getCompilerPhaseTerms(
  compiler: Awaited<ReturnType<typeof compileAndLinkCompiler>>,
): CompilerPhaseTerms {
  const { ps } = compiler;
  return {
    nil: parseSKI(lowerToSKI(ps.terms.get("Prelude.nil")!)),
    cons: parseSKI(lowerToSKI(ps.terms.get("Prelude.cons")!)),
    phase1: parseSKI(lowerToSKI(ps.terms.get("Telemetry.phase1")!)),
    phase2: parseSKI(lowerToSKI(ps.terms.get("Telemetry.phase2")!)),
    phase3: parseSKI(lowerToSKI(ps.terms.get("Telemetry.phase3")!)),
    phase4: parseSKI(lowerToSKI(ps.terms.get("Telemetry.phase4")!)),
    phase5: parseSKI(lowerToSKI(ps.terms.get("TelemetryTail.phase5")!)),
    phase6: parseSKI(lowerToSKI(ps.terms.get("TelemetryTail.phase6")!)),
    phase6TextProfile: parseSKI(
      lowerToSKI(ps.terms.get("TelemetryTail.phase6TextProfile")!),
    ),
    phase6TextProfileOutputBytes: parseSKI(
      lowerToSKI(ps.terms.get("TelemetryTail.phase6TextProfileOutputBytes")!),
    ),
    phase6TextProfileParenBytes: parseSKI(
      lowerToSKI(ps.terms.get("TelemetryTail.phase6TextProfileParenBytes")!),
    ),
    phase6TextProfileSpaceBytes: parseSKI(
      lowerToSKI(ps.terms.get("TelemetryTail.phase6TextProfileSpaceBytes")!),
    ),
    phase6TextProfileByteLiterals: parseSKI(
      lowerToSKI(ps.terms.get("TelemetryTail.phase6TextProfileByteLiterals")!),
    ),
    phase6TextProfileMaxDepth: parseSKI(
      lowerToSKI(ps.terms.get("TelemetryTail.phase6TextProfileMaxDepth")!),
    ),
  };
}

async function registerCompilerTraceSymbols(
  session: ThanatosSession,
): Promise<void> {
  await session.registerTraceSource({
    sourceId: TRACE_SOURCE_TELEMETRY_PHASE1,
    file: "lib/compiler/telemetry.trip",
    startLine: 34,
    startCol: 1,
    endLine: 38,
    endCol: 3,
  });
  await session.registerTraceSource({
    sourceId: TRACE_SOURCE_TELEMETRY_PHASE2,
    file: "lib/compiler/telemetry.trip",
    startLine: 40,
    startCol: 1,
    endLine: 44,
    endCol: 3,
  });
  await session.registerTraceSource({
    sourceId: TRACE_SOURCE_TELEMETRY_PHASE3,
    file: "lib/compiler/telemetry.trip",
    startLine: 46,
    startCol: 1,
    endLine: 50,
    endCol: 3,
  });
  await session.registerTraceSource({
    sourceId: TRACE_SOURCE_TELEMETRY_PHASE4,
    file: "lib/compiler/telemetry.trip",
    startLine: 52,
    startCol: 1,
    endLine: 59,
    endCol: 13,
  });
  await session.registerTraceSource({
    sourceId: TRACE_SOURCE_TELEMETRY_PHASE5,
    file: "test/compiler/inputs/bootstrapTelemetryTail.trip",
    startLine: 137,
    startCol: 1,
    endLine: 143,
    endCol: 31,
  });
  await session.registerTraceSource({
    sourceId: TRACE_SOURCE_TELEMETRY_PHASE6,
    file: "test/compiler/inputs/bootstrapTelemetryTail.trip",
    startLine: 145,
    startCol: 1,
    endLine: 149,
    endCol: 3,
  });
  await session.registerTraceSource({
    sourceId: TRACE_SOURCE_COMPILER_COMPILE_TO_COMB,
    file: "lib/compiler/index.trip",
    startLine: 36,
    startCol: 1,
    endLine: 56,
    endCol: 3,
  });

  await session.registerTraceProc({
    procId: TRACE_PROC_TELEMETRY_PHASE1,
    name: "Telemetry.phase1",
    phaseId: TRACE_PHASE_TOKENIZE,
    primarySourceId: TRACE_SOURCE_TELEMETRY_PHASE1,
    arity: 1,
  });
  await session.registerTraceProc({
    procId: TRACE_PROC_TELEMETRY_PHASE2,
    name: "Telemetry.phase2",
    phaseId: TRACE_PHASE_PARSE,
    primarySourceId: TRACE_SOURCE_TELEMETRY_PHASE2,
    arity: 1,
  });
  await session.registerTraceProc({
    procId: TRACE_PROC_TELEMETRY_PHASE3,
    name: "Telemetry.phase3",
    phaseId: TRACE_PHASE_ELABORATE,
    primarySourceId: TRACE_SOURCE_TELEMETRY_PHASE3,
    arity: 1,
  });
  await session.registerTraceProc({
    procId: TRACE_PROC_TELEMETRY_PHASE4,
    name: "Telemetry.phase4",
    phaseId: TRACE_PHASE_LOWER,
    primarySourceId: TRACE_SOURCE_TELEMETRY_PHASE4,
    arity: 1,
  });
  await session.registerTraceProc({
    procId: TRACE_PROC_TELEMETRY_PHASE5,
    name: "TelemetryTail.phase5",
    phaseId: TRACE_PHASE_FIND_MAIN,
    primarySourceId: TRACE_SOURCE_TELEMETRY_PHASE5,
    arity: 1,
  });
  await session.registerTraceProc({
    procId: TRACE_PROC_TELEMETRY_PHASE6,
    name: "TelemetryTail.phase6",
    phaseId: TRACE_PHASE_UNPARSE,
    primarySourceId: TRACE_SOURCE_TELEMETRY_PHASE6,
    arity: 1,
  });
  await session.registerTraceProc({
    procId: TRACE_PROC_COMPILER_COMPILE_TO_COMB,
    name: "Compiler.compileToComb",
    phaseId: TRACE_PHASE_LOWER,
    primarySourceId: TRACE_SOURCE_COMPILER_COMPILE_TO_COMB,
    arity: 1,
  });
}

async function listTraceDumpPaths(traceDir: string): Promise<string[]> {
  const dumps: string[] = [];
  for await (const entry of Deno.readDir(traceDir)) {
    if (entry.isFile && entry.name.endsWith(".json")) {
      dumps.push(join(traceDir, entry.name));
    }
  }
  dumps.sort();
  return dumps;
}

function summarizePhaseRanking(
  metrics: PhaseMetric[],
  key: "elapsedMs" | "totalSteps",
): string {
  return [...metrics]
    .sort((left, right) => {
      if (left.timedOut !== right.timedOut) {
        return Number(right.timedOut) - Number(left.timedOut);
      }
      return right[key] - left[key];
    })
    .map((metric) =>
      metric.timedOut
        ? `${metric.phase}=timeout@${Math.round(metric.elapsedMs)}`
        : `${metric.phase}=${Math.round(metric[key])}`
    )
    .join(" ");
}

async function reduceBootstrapPhase(
  phaseName: string,
  phaseTerm: SKIExpression,
  currentDag: string,
  timeoutMs = PHASE_TIMEOUT_MS,
): Promise<{ metric: PhaseMetric; resultDag?: string }> {
  const session = new ThanatosSession();
  let reductionPromise: Promise<string> | null = null;

  try {
    session.start();
    await session.ping();
    await session.reset();

    const startTime = performance.now();
    const phaseDag = toDagWire(phaseTerm);
    const combinedDag = combineDagWires(phaseDag, currentDag);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () =>
            reject(
              new Error(
                `Timeout: Phase ${phaseName} exceeded ${timeoutMs / 1000}s`,
              ),
            ),
          timeoutMs,
        );
      });

      reductionPromise = session.reduceDag(combinedDag);
      reductionPromise.catch(() => {});
      const resultDag = await Promise.race([
        reductionPromise,
        timeoutPromise,
      ]);
      clearTimeout(timeoutId);

      const endTime = performance.now();
      const statsLine = await session.stats();
      const topMatch = statsLine.match(/top=(\d+)/);
      const nodesMatch = statsLine.match(/total_nodes=(\d+)/);
      const stepsMatch = statsLine.match(/total_steps=(\d+)/);
      const consMatch = statsLine.match(/total_cons_allocs=(\d+)/);
      const contMatch = statsLine.match(/total_cont_allocs=(\d+)/);
      const suspMatch = statsLine.match(/total_susp_allocs=(\d+)/);
      const duplicateMatch = statsLine.match(/duplicate_lost_allocs=(\d+)/);
      const hashconsHitsMatch = statsLine.match(/hashcons_hits=(\d+)/);
      const hashconsMissesMatch = statsLine.match(/hashcons_misses=(\d+)/);

      const metric: PhaseMetric = {
        phase: phaseName,
        uniqueNodeCount: resultDag.split(" ").filter(Boolean).length,
        totalNodeCount: nodesMatch ? parseInt(nodesMatch[1]!, 10) : 0,
        totalConsAllocs: consMatch ? parseInt(consMatch[1]!, 10) : 0,
        totalContAllocs: contMatch ? parseInt(contMatch[1]!, 10) : 0,
        totalSuspAllocs: suspMatch ? parseInt(suspMatch[1]!, 10) : 0,
        duplicateLostAllocs: duplicateMatch
          ? parseInt(duplicateMatch[1]!, 10)
          : 0,
        hashconsHits: hashconsHitsMatch
          ? parseInt(hashconsHitsMatch[1]!, 10)
          : 0,
        hashconsMisses: hashconsMissesMatch
          ? parseInt(hashconsMissesMatch[1]!, 10)
          : 0,
        totalSteps: stepsMatch ? parseInt(stepsMatch[1]!, 10) : 0,
        arenaTop: topMatch ? parseInt(topMatch[1]!, 10) : 0,
        elapsedMs: endTime - startTime,
        timedOut: false,
      };

      return { metric, resultDag };
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);
      const elapsedMs = performance.now() - startTime;
      if ((error as Error).message.includes("Timeout")) {
        reductionPromise?.catch(() => {});
        try {
          session.signal("SIGKILL");
        } catch {
          // ignore
        }
        return {
          metric: {
            phase: phaseName,
            uniqueNodeCount: 0,
            totalNodeCount: 0,
            totalConsAllocs: 0,
            totalContAllocs: 0,
            totalSuspAllocs: 0,
            duplicateLostAllocs: 0,
            hashconsHits: 0,
            hashconsMisses: 0,
            totalSteps: 0,
            arenaTop: 0,
            elapsedMs,
            timedOut: true,
          },
        };
      }
      throw error;
    }
  } finally {
    await session.close().catch(() => {});
  }
}

function logPhaseMetric(metric: PhaseMetric): void {
  if (metric.timedOut) {
    console.log(
      `[${metric.phase}] TIMEOUT after ${metric.elapsedMs.toFixed(2)}ms`,
    );
    return;
  }

  const duplicationFactor = metric.uniqueNodeCount > 0
    ? (metric.totalNodeCount / metric.uniqueNodeCount).toFixed(2)
    : "0.00";
  const hashconsHitRate = (metric.hashconsHits + metric.hashconsMisses) > 0
    ? (
      (metric.hashconsHits / (metric.hashconsHits + metric.hashconsMisses)) *
      100
    ).toFixed(2)
    : "0.00";
  console.log(
    `[${metric.phase}] Unique: ${metric.uniqueNodeCount}, Total: ${metric.totalNodeCount}, Duplication: ${duplicationFactor}x, Cons: ${metric.totalConsAllocs}, Cont: ${metric.totalContAllocs}, Susp: ${metric.totalSuspAllocs}, DupLost: ${metric.duplicateLostAllocs}, HashHits: ${metric.hashconsHits}, HashMisses: ${metric.hashconsMisses}, HitRate: ${hashconsHitRate}%, Steps: ${metric.totalSteps}, Time: ${
      metric.elapsedMs.toFixed(2)
    }ms`,
  );
}

async function readNatResultDag(resultDag: string): Promise<bigint> {
  return await UnChurchNumber(fromDagWire(resultDag));
}

async function reduceNatMetricOverDag(
  session: ThanatosSession,
  term: SKIExpression,
  phase6ResultDag: string,
): Promise<bigint> {
  await session.reset();
  const resultDag = await session.reduceDag(
    combineDagWires(toDagWire(term), phase6ResultDag),
  );
  return await readNatResultDag(resultDag);
}

async function readPhase6Shape(
  terms: CompilerPhaseTerms,
  phase6ResultDag: string,
): Promise<Phase6ShapeMetric> {
  const session = new ThanatosSession();

  try {
    session.start(1);
    await session.ping();
    await session.reset();

    const profileDag = await session.reduceDag(
      combineDagWires(toDagWire(terms.phase6TextProfile), phase6ResultDag),
    );
    const readField = async (term: SKIExpression): Promise<bigint> =>
      await reduceNatMetricOverDag(session, term, profileDag);

    const outputBytes = await readField(terms.phase6TextProfileOutputBytes);
    const parenBytes = await readField(terms.phase6TextProfileParenBytes);
    const spaceBytes = await readField(terms.phase6TextProfileSpaceBytes);
    const byteLiterals = await readField(terms.phase6TextProfileByteLiterals);
    const maxDepth = await readField(terms.phase6TextProfileMaxDepth);
    const appNodes = parenBytes / 2n;
    const termNodes = outputBytes === 0n ? 0n : appNodes + 1n;

    return {
      appNodes,
      termNodes,
      byteLiterals,
      maxDepth,
      outputBytes,
      parenBytes,
      spaceBytes,
    };
  } finally {
    await session.close().catch(() => {});
  }
}

function ratioString(
  numerator: bigint | number,
  denominator: bigint | number,
): string {
  const numeratorValue = typeof numerator === "bigint"
    ? Number(numerator)
    : numerator;
  const denominatorValue = typeof denominator === "bigint"
    ? Number(denominator)
    : denominator;
  if (
    !Number.isFinite(numeratorValue) || !Number.isFinite(denominatorValue) ||
    denominatorValue === 0
  ) {
    return "0.00";
  }
  return (numeratorValue / denominatorValue).toFixed(2);
}

function logPhase6Shape(
  shape: Phase6ShapeMetric,
  phase5Metric?: PhaseMetric,
  phase6Metric?: PhaseMetric,
): void {
  const logicalNodes = shape.appNodes + shape.termNodes;
  const terminalBytes = shape.outputBytes - shape.parenBytes - shape.spaceBytes;
  const phase5UniqueNodes = phase5Metric?.uniqueNodeCount ?? 0;
  const phase5SharingProxy = phase5UniqueNodes > 0
    ? ratioString(logicalNodes, phase5UniqueNodes)
    : "0.00";

  console.log(
    `[phase6 shape] app_nodes=${shape.appNodes} term_nodes=${shape.termNodes} byte_literals=${shape.byteLiterals} max_depth=${shape.maxDepth} output_bytes=${shape.outputBytes} paren_bytes=${shape.parenBytes} space_bytes=${shape.spaceBytes} terminal_bytes=${terminalBytes} logical_nodes=${logicalNodes} phase5_unique_nodes=${phase5UniqueNodes} logical_nodes_per_phase5_unique=${phase5SharingProxy}`,
  );

  if (!phase6Metric || phase6Metric.timedOut) return;

  console.log(
    `[phase6 ratios] steps_per_output_byte=${
      ratioString(phase6Metric.totalSteps, shape.outputBytes)
    } steps_per_app=${
      ratioString(phase6Metric.totalSteps, shape.appNodes)
    } output_bytes_per_app=${ratioString(shape.outputBytes, shape.appNodes)}`,
  );
}

function logPhase6Proxy(
  phase5Metric?: PhaseMetric,
  phase6Metric?: PhaseMetric,
): void {
  if (!phase5Metric || !phase6Metric || phase6Metric.timedOut) return;

  console.log(
    `[phase6 proxy] unique_output_nodes=${phase6Metric.uniqueNodeCount} unique_output_nodes_per_phase5_unique=${
      ratioString(phase6Metric.uniqueNodeCount, phase5Metric.uniqueNodeCount)
    } steps_per_unique_output_node=${
      ratioString(phase6Metric.totalSteps, phase6Metric.uniqueNodeCount)
    } cons_per_unique_output_node=${
      ratioString(phase6Metric.totalConsAllocs, phase6Metric.uniqueNodeCount)
    }`,
  );
}

function summarizeWorkerProvenance(dumps: TraceDump[]): string {
  return dumps.map((dump) =>
    dump.workers.map((worker) =>
      `${worker.state}:${worker.phase_id}/${worker.proc_id}/${worker.source_id}`
    ).join(",")
  ).join(" | ");
}

function findActiveWorkerDump(
  dumps: TraceDump[],
  phaseId: number,
  procId: number,
  sourceId: number,
): TraceDump | undefined {
  return dumps.find((dump) =>
    dump.workers.some((worker) =>
      worker.state === "running" &&
      worker.phase_id === phaseId &&
      worker.proc_id === procId &&
      worker.source_id === sourceId
    )
  );
}

async function runTracedReduction(
  dag: string,
  provenance: {
    phaseId: number;
    procId: number;
    sourceId: number;
    blockId: number;
  },
): Promise<{ resultDag: string; dumps: TraceDump[]; dumpPaths: string[] }> {
  const traceDir = await Deno.makeTempDir();
  const session = new ThanatosSession();
  let signalLoop: Promise<void> | null = null;
  let keepSignaling = true;

  try {
    session.start(1, {
      THANATOS_TRACE_DIR: traceDir,
      THANATOS_TRACE_TIMEOUT_MS: "200",
    });
    await session.ping();
    await registerCompilerTraceSymbols(session);
    await session.reset();

    const resultPromise = session.reduceDagWithTrace(dag, provenance);
    signalLoop = (async () => {
      for (let i = 0; keepSignaling && i < 8; i++) {
        session.signal("SIGHUP");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();

    const resultDag = await resultPromise;
    keepSignaling = false;
    await signalLoop;

    await waitForTraceDump(traceDir, 5000);
    const dumpPaths = await listTraceDumpPaths(traceDir);
    const dumps = await Promise.all(
      dumpPaths.map((path) => readTraceDumpJson<TraceDump>(path, 5000)),
    );
    return { resultDag, dumps, dumpPaths };
  } finally {
    keepSignaling = false;
    await signalLoop?.catch(() => {});
    await session.close();
    await Deno.remove(traceDir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name: "Bootstrapped Single-File Compiler Telemetry",
  fn: async (t) => {
    const compiler = await compileAndLinkBootstrapTelemetryCompiler();
    const terms = getCompilerPhaseTerms(compiler);
    const enablePhase6Shape = Deno.env.get("BOOTSTRAP_PHASE6_SHAPE") === "1";

    const phases = [
      {
        name: "phase1",
        term: terms.phase1,
      },
      {
        name: "phase2",
        term: terms.phase2,
      },
      {
        name: "phase3",
        term: terms.phase3,
      },
      {
        name: "phase4",
        term: terms.phase4,
      },
      {
        name: "phase5",
        term: terms.phase5,
      },
      {
        name: "phase6",
        term: terms.phase6,
      },
    ];

    const runTestForFile = async (filePath: string) => {
      const sourceText = await Deno.readTextFile(filePath);
      const sourceBytes = new TextEncoder().encode(sourceText);
      let currentDag = toDagWire(
        encodeListU8(sourceBytes, terms.nil, terms.cons),
      );

      const metrics: PhaseMetric[] = [];
      let phase6Shape: Phase6ShapeMetric | null = null;
      let phase6ResultDag: string | null = null;

      for (const phase of phases) {
        let phaseTimedOut = false;
        const ok = await t.step(`Phase: ${phase.name}`, async () => {
          const { metric, resultDag } = await reduceBootstrapPhase(
            phase.name,
            phase.term,
            currentDag,
          );
          metrics.push(metric);
          logPhaseMetric(metric);

          if (!metric.timedOut) {
            const budget = PHASE_BUDGETS[phase.name];
            if (
              budget !== undefined && metric.uniqueNodeCount > budget &&
              resultDag !== undefined
            ) {
              throw new Error(`[bootstrapped budget exceeded]
file: ${filePath}
phase: ${phase.name}
unique_nodes: ${metric.uniqueNodeCount}
budget: ${budget}
elapsed_ms: ${metric.elapsedMs.toFixed(2)}`);
            }

            assert(
              resultDag !== undefined,
              `${phase.name} returned no result DAG`,
            );
            currentDag = resultDag;
            if (phase.name === "phase6") {
              phase6ResultDag = resultDag;
            }
            return;
          }

          phaseTimedOut = true;
        });

        if (!ok || phaseTimedOut) break;
      }

      if (enablePhase6Shape && phase6ResultDag !== null) {
        phase6Shape = await readPhase6Shape(terms, phase6ResultDag);
      }
      return { metrics, phase6Shape };
    };

    const { metrics, phase6Shape } = await runTestForFile(
      join(PROJECT_ROOT, "test", "compiler", "inputs", "small.trip"),
    );
    assert(
      metrics.length >= 5,
      "expected the bootstrap telemetry to reach phase5",
    );
    const phase5Metric = metrics.find((metric) => metric.phase === "phase5");
    const phase6Metric = metrics.find((metric) => metric.phase === "phase6");
    logPhase6Proxy(phase5Metric, phase6Metric);
    if (enablePhase6Shape) {
      if (phase6Shape === null) {
        throw new Error("expected phase6 shape profile after phase6");
      }
      const phase6ShapeMetric = phase6Shape as Phase6ShapeMetric;
      assert(
        phase6ShapeMetric.outputBytes > 0n,
        "expected phase6 output bytes > 0",
      );
      assert(
        phase6ShapeMetric.maxDepth > 0n,
        "expected phase6 max depth > 0",
      );
      logPhase6Shape(phase6ShapeMetric, phase5Metric, phase6Metric);
    }
    console.log(
      `[bootstrap spend summary] time_rank=${
        summarizePhaseRanking(metrics, "elapsedMs")
      } step_rank=${summarizePhaseRanking(metrics, "totalSteps")}`,
    );
  },
});

Deno.test({
  name:
    "Bootstrapped compiler trace provenance distinguishes Telemetry.phase1 and phase4",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const compiler = await compileAndLinkBootstrapTelemetryCompiler();
    const terms = getCompilerPhaseTerms(compiler);
    const phase1Dag = toDagWire(terms.phase1);
    const phase2Dag = toDagWire(terms.phase2);
    const phase3Dag = toDagWire(terms.phase3);
    const phase4Dag = toDagWire(terms.phase4);
    const sourceText = await Deno.readTextFile(
      join(PROJECT_ROOT, "test", "compiler", "inputs", "small.trip"),
    );
    const sourceBytes = new TextEncoder().encode(sourceText);
    const sourceDag = toDagWire(
      encodeListU8(sourceBytes, terms.nil, terms.cons),
    );

    const plainSession = new ThanatosSession();
    try {
      plainSession.start(1);
      await plainSession.ping();
      await plainSession.reset();

      const phase1Trace = await runTracedReduction(
        combineDagWires(phase1Dag, sourceDag),
        {
          phaseId: TRACE_PHASE_TOKENIZE,
          procId: TRACE_PROC_TELEMETRY_PHASE1,
          sourceId: TRACE_SOURCE_TELEMETRY_PHASE1,
          blockId: 1,
        },
      );
      const phase1ActiveDump = findActiveWorkerDump(
        phase1Trace.dumps,
        TRACE_PHASE_TOKENIZE,
        TRACE_PROC_TELEMETRY_PHASE1,
        TRACE_SOURCE_TELEMETRY_PHASE1,
      );
      assert(
        phase1ActiveDump !== undefined,
        `expected live Telemetry.phase1 provenance, saw ${
          summarizeWorkerProvenance(phase1Trace.dumps)
        }`,
      );
      assert(
        phase1Trace.dumps.some((dump) =>
          dump.workers.some((worker) =>
            worker.recent_events.some((event) =>
              event.phase_id === TRACE_PHASE_TOKENIZE &&
              event.proc_id === TRACE_PROC_TELEMETRY_PHASE1 &&
              event.source_id === TRACE_SOURCE_TELEMETRY_PHASE1
            )
          )
        ),
        "expected Telemetry.phase1 provenance in recent events",
      );
      assert(
        phase1Trace.dumps.some((dump) =>
          dump.symbols.procs.some((proc) => proc.name === "Telemetry.phase1") &&
          dump.symbols.procs.some((proc) =>
            proc.name === "Compiler.compileToComb"
          ) &&
          dump.symbols.sources.some((source) =>
            source.file === "lib/compiler/telemetry.trip"
          )
        ),
        "expected registered compiler trace symbols in phase1 dump",
      );

      await plainSession.reset();
      const phase2ResultDag = await plainSession.reduceDag(
        combineDagWires(phase2Dag, phase1Trace.resultDag),
      );
      await plainSession.reset();
      const phase3ResultDag = await plainSession.reduceDag(
        combineDagWires(phase3Dag, phase2ResultDag),
      );

      const phase4Trace = await runTracedReduction(
        combineDagWires(phase4Dag, phase3ResultDag),
        {
          phaseId: TRACE_PHASE_LOWER,
          procId: TRACE_PROC_TELEMETRY_PHASE4,
          sourceId: TRACE_SOURCE_TELEMETRY_PHASE4,
          blockId: 4,
        },
      );
      const phase4ActiveDump = findActiveWorkerDump(
        phase4Trace.dumps,
        TRACE_PHASE_LOWER,
        TRACE_PROC_TELEMETRY_PHASE4,
        TRACE_SOURCE_TELEMETRY_PHASE4,
      );
      assert(
        phase4ActiveDump !== undefined,
        `expected live Telemetry.phase4 provenance, saw ${
          summarizeWorkerProvenance(phase4Trace.dumps)
        }`,
      );
      assert(
        phase4Trace.dumps.some((dump) =>
          dump.workers.some((worker) =>
            worker.recent_events.some((event) =>
              event.phase_id === TRACE_PHASE_LOWER &&
              event.proc_id === TRACE_PROC_TELEMETRY_PHASE4 &&
              event.source_id === TRACE_SOURCE_TELEMETRY_PHASE4
            )
          )
        ),
        "expected Telemetry.phase4 provenance in recent events",
      );
      assert(
        !phase1ActiveDump.workers.some((worker) =>
          worker.proc_id === TRACE_PROC_TELEMETRY_PHASE4
        ),
        "phase1 active dump should not be attributed to Telemetry.phase4",
      );
      assert(
        !phase4ActiveDump.workers.some((worker) =>
          worker.proc_id === TRACE_PROC_TELEMETRY_PHASE1
        ),
        "phase4 active dump should not be attributed to Telemetry.phase1",
      );

      console.log(
        `[compiler trace provenance] phase1_dumps=${phase1Trace.dumpPaths.length} phase4_dumps=${phase4Trace.dumpPaths.length} phase1_proc=${TRACE_PROC_TELEMETRY_PHASE1} phase4_proc=${TRACE_PROC_TELEMETRY_PHASE4}`,
      );
    } finally {
      await plainSession.close();
    }
  },
});

function combineDagWires(dag1: string, dag2: string): string {
  const tokens1 = dag1.trim().split(/\s+/);
  const tokens2 = dag2.trim().split(/\s+/);

  const offset = tokens1.length;
  const translated2 = tokens2.map((t) => {
    if (t.startsWith("@")) {
      const parts = t.slice(1).split(",");
      const L = parseInt(parts[0]!, 10);
      const R = parseInt(parts[1]!, 10);
      return `@${L + offset},${R + offset}`;
    }
    return t;
  });

  const root1 = tokens1.length - 1;
  const root2 = tokens1.length + tokens2.length - 1;

  return [...tokens1, ...translated2, `@${root1},${root2}`].join(" ");
}

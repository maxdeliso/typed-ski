/**
 * Test harness for running SKI reduction via the native thanatos binary.
 * Uses a single long-lived daemon process (singleton). All tests share one thanatos;
 * runThanatosBatch sends expressions through the session with surface↔DAG conversion.
 */

import { assert, assertEquals, assertRejects, assertThrows } from "std/assert";
import { existsSync } from "std/fs";
import { dirname, fromFileUrl, join } from "std/path";
import type { Evaluator } from "../lib/evaluator/evaluator.ts";
import type { SKIExpression } from "../lib/ski/expression.ts";
import { apply, unparseSKI } from "../lib/ski/expression.ts";
import { term } from "../lib/ski/terminal.ts";
import type { SKITerminalSymbol } from "../lib/ski/terminal.ts";
import { C, I, ReadOne, WriteOne } from "../lib/ski/terminal.ts";
import { parseSKI } from "../lib/parser/ski.ts";

const __dirname = dirname(fromFileUrl(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const TEST_NATIVE_WORKERS = 2;

/** Path to the thanatos binary (built by make build-native). Override with env THANATOS_BIN for ASan etc. */
export const THANATOS_BIN =
  typeof Deno !== "undefined" && Deno.env.get("THANATOS_BIN")
    ? Deno.env.get("THANATOS_BIN")!
    : join(PROJECT_ROOT, "bin", "thanatos");

export function thanatosAvailable(): boolean {
  return existsSync(THANATOS_BIN);
}

/**
 * DAG wire format: terminals S K I B C P Q R , . E | Uxx | @L,R (space-separated, postorder).
 * Uses object identity (Map) for node indices: preserves sharing only when the AST already
 * has shared references. Does not do structural hash-consing; the C side preserves
 * sharing present in the imported wire but the TS encoder does not invent sharing.
 */
export function toDagWire(expr: SKIExpression): string {
  const order: SKIExpression[] = [];
  const visited = new Set<SKIExpression>();
  function postorder(e: SKIExpression): void {
    if (visited.has(e)) return;
    if (e.kind === "non-terminal") {
      postorder(e.lft);
      postorder(e.rgt);
    }
    visited.add(e);
    order.push(e);
  }
  postorder(expr);
  const nodeToIndex = new Map<SKIExpression, number>();
  order.forEach((n, i) => nodeToIndex.set(n, i));
  const tokens: string[] = [];
  for (const n of order) {
    if (n.kind === "terminal") {
      tokens.push(n.sym);
    } else if (n.kind === "u8") {
      tokens.push("U" + n.value.toString(16).padStart(2, "0").toUpperCase());
    } else {
      tokens.push(
        "@" + nodeToIndex.get(n.lft)! + "," + nodeToIndex.get(n.rgt)!,
      );
    }
  }
  return tokens.join(" ");
}

const DAG_TERMINAL_CHARS = new Set<string>([
  "S",
  "K",
  "I",
  "B",
  "C",
  "P",
  "Q",
  "R",
  ",",
  ".",
  "E",
  "L",
  "D",
  "M",
  "A",
  "O",
]);

function dagCharToSym(c: string): SKITerminalSymbol {
  const s = c as SKITerminalSymbol;
  if (!DAG_TERMINAL_CHARS.has(c)) throw new Error("invalid DAG terminal: " + c);
  return s;
}

export function fromDagWire(dagStr: string): SKIExpression {
  const tokens = dagStr.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new Error("empty DAG");
  const nodes: SKIExpression[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.length === 1 && DAG_TERMINAL_CHARS.has(t)) {
      nodes.push(term(dagCharToSym(t)));
    } else if (t.startsWith("#u8(") && t.endsWith(")")) {
      const byte = parseInt(t.slice(4, -1), 10);
      if (Number.isNaN(byte) || byte < 0 || byte > 255) {
        throw new Error("invalid U8: " + t);
      }
      nodes.push({ kind: "u8", value: byte });
    } else if (t.startsWith("U") && t.length === 3) {
      const byte = parseInt(t.slice(1), 16);
      if (Number.isNaN(byte) || byte < 0 || byte > 255) {
        throw new Error("invalid U8: " + t);
      }
      nodes.push({ kind: "u8", value: byte });
    } else if (t.startsWith("@")) {
      const comma = t.indexOf(",", 1);
      if (comma < 0) throw new Error("invalid app: " + t);
      const L = parseInt(t.slice(1, comma), 10);
      const R = parseInt(t.slice(comma + 1), 10);
      if (L >= i || R >= i || L < 0 || R < 0) {
        throw new Error("invalid app indices: " + t);
      }
      nodes.push(apply(nodes[L]!, nodes[R]!));
    } else {
      throw new Error("invalid DAG token: " + t);
    }
  }
  return nodes[nodes.length - 1]!;
}

/** Long-lived daemon session: one process, DAG protocol, serialized requests. */
export class ThanatosSession {
  private child: Deno.ChildProcess | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private lineBuffer = new Uint8Array(0);
  private pending: Promise<void> = Promise.resolve();
  private closed = false;

  /** Start the daemon (spawns process with --daemon). Call once. */
  start(workers?: number): void {
    if (this.child != null) return;
    if (!thanatosAvailable()) throw new Error("thanatos binary not found");
    const w = workers ?? defaultWorkerCount();
    this.child = new Deno.Command(THANATOS_BIN, {
      args: ["--daemon", String(w)],
      cwd: PROJECT_ROOT,
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    this.writer = this.child.stdin.getWriter();
    this.reader = this.child.stdout.getReader();
  }

  /** Send one request line and return the response line. Must be called serially. */
  private async request(line: string): Promise<string> {
    if (this.writer == null || this.reader == null) {
      throw new Error("ThanatosSession not started");
    }
    if (this.closed) throw new Error("ThanatosSession closed");

    const encoder = new TextEncoder();
    await this.writer.write(encoder.encode(line + "\n"));

    const decoder = new TextDecoder();
    while (true) {
      const i = this.lineBuffer.indexOf(0x0a);
      if (i >= 0) {
        const resp = decoder.decode(this.lineBuffer.subarray(0, i)).replace(
          /\r$/,
          "",
        );
        this.lineBuffer = this.lineBuffer.subarray(i + 1);
        return resp;
      }
      const { done, value } = await this.reader.read();
      if (done) throw new Error("thanatos daemon stdout closed");
      if (value && value.length > 0) {
        const merged = new Uint8Array(this.lineBuffer.length + value.length);
        merged.set(this.lineBuffer);
        merged.set(value, this.lineBuffer.length);
        this.lineBuffer = merged;
      }
    }
  }

  /** Serialized: run request after previous pending completes, return response. */
  private serialRequest(line: string): Promise<string> {
    const prev = this.pending;
    let resolveNext!: () => void;
    this.pending = new Promise<void>((r) => {
      resolveNext = r;
    });
    const result = prev.then(() => this.request(line));
    result.finally(() => resolveNext());
    return result;
  }

  /** Reduce a DAG string to normal form; returns DAG string or throws on ERR. Starts daemon on first use if needed. */
  async reduceDag(dag: string): Promise<string> {
    this.start();
    const resp = await this.serialRequest("REDUCE " + dag.trim());
    if (resp.startsWith("OK ")) return resp.slice(3).trim();
    if (resp === "OK") return "";
    if (resp.startsWith("ERR ")) throw new Error("thanatos: " + resp.slice(4));
    throw new Error("thanatos: unexpected " + resp);
  }

  /** Reset the arena (clean slate). Starts daemon on first use if needed. */
  async reset(): Promise<void> {
    this.start();
    const resp = await this.serialRequest("RESET");
    if (resp !== "OK") throw new Error("thanatos: " + resp);
  }

  /** Ping the daemon. Starts daemon on first use if needed. */
  async ping(): Promise<void> {
    this.start();
    const resp = await this.serialRequest("PING");
    if (resp !== "OK") throw new Error("thanatos: " + resp);
  }

  /** STATS: returns the full response line (e.g. "OK top=0 capacity=... events=... dropped=..."). */
  async stats(): Promise<string> {
    this.start();
    const resp = await this.serialRequest("STATS");
    if (!resp.startsWith("OK ")) throw new Error("thanatos: " + resp);
    return resp;
  }

  /** Close the session (sends QUIT, closes stdin). Idempotent. Clears singleton so next getThanatosSession() starts a new process. Signal listeners are not removed (registered once at module level). */
  async close(): Promise<void> {
    if (this.closed) return;
    const child = this.child;
    try {
      if (this.writer != null && this.reader != null) {
        await this.serialRequest("QUIT");
      }
    } catch {
      // daemon may have exited; ignore
    } finally {
      this.closed = true;
      try {
        await this.writer?.close();
      } catch {
        // ignore
      }
      try {
        await this.reader?.cancel();
      } catch {
        // ignore
      }
      this.child = null;
      this.writer = null;
      this.reader = null;
      if (child != null) await child.status;
      removeSignalListeners();
      getSessionPromiseRef().current = null;
    }
  }
}

function defaultWorkerCount(): number {
  const detected = typeof navigator !== "undefined" &&
      navigator.hardwareConcurrency > 0
    ? navigator.hardwareConcurrency
    : 4;
  return Math.max(TEST_NATIVE_WORKERS, Math.min(detected, 4));
}

/** Global key for the singleton so one process is shared across all test files. */
const THANATOS_SESSION_KEY = "__thanatosSessionPromise";

declare global {
  interface GlobalThis {
    [THANATOS_SESSION_KEY]?: Promise<ThanatosSession> | null;
  }
}

function getSessionPromiseRef(): {
  get current(): Promise<ThanatosSession> | null;
  set current(v: Promise<ThanatosSession> | null);
} {
  return {
    get current() {
      return (globalThis as GlobalThis)[THANATOS_SESSION_KEY] ?? null;
    },
    set current(v: Promise<ThanatosSession> | null) {
      (globalThis as GlobalThis)[THANATOS_SESSION_KEY] = v;
    },
  };
}

function onProcessSignal(): void {
  console.error("[thanatos harness] process signal received, closing session");
  const ref = getSessionPromiseRef();
  const p = ref.current;
  if (p === null) return;
  ref.current = null;
  p.then((s) => s.close()).catch(() => {});
}

let signalListenersRegistered = false;

function ensureSignalListeners(): void {
  if (signalListenersRegistered) return;
  if (
    typeof Deno !== "undefined" &&
    typeof Deno.addSignalListener === "function"
  ) {
    Deno.addSignalListener("SIGINT", onProcessSignal);
    Deno.addSignalListener("SIGTERM", onProcessSignal);
    signalListenersRegistered = true;
  }
}

function removeSignalListeners(): void {
  if (!signalListenersRegistered) return;
  if (
    typeof Deno !== "undefined" &&
    typeof Deno.removeSignalListener === "function"
  ) {
    try {
      Deno.removeSignalListener("SIGINT", onProcessSignal);
    } catch {
      /* ignore */
    }
    try {
      Deno.removeSignalListener("SIGTERM", onProcessSignal);
    } catch {
      /* ignore */
    }
    signalListenersRegistered = false;
  }
}

/**
 * Return the singleton thanatos daemon session. Starts the process on first call;
 * all callers (across all test files) share the same process. Thread-safe: one init.
 * Registers SIGINT/SIGTERM once (module-level) to close the session on signal.
 */
export function getThanatosSession(): Promise<ThanatosSession> {
  if (!thanatosAvailable()) throw new Error("thanatos binary not found");
  const ref = getSessionPromiseRef();
  if (ref.current !== null) return ref.current;
  ensureSignalListeners();
  ref.current = Promise.resolve().then(() => {
    const session = new ThanatosSession();
    session.start(defaultWorkerCount());
    return session;
  });
  return ref.current;
}

/**
 * Evaluator that does not reduce; for decoding already-normal forms from thanatos stdout.
 */
export const passthroughEvaluator: Evaluator = {
  stepOnce: (expr: SKIExpression) => ({ altered: false, expr }),
  reduce: (expr: SKIExpression) => expr,
  reduceAsync: (expr: SKIExpression) => Promise.resolve(expr),
};

/**
 * Run multiple surface-syntax expressions through the singleton thanatos daemon.
 * One process; for each expression: parse → DAG → one REDUCE request → wait for response
 * → decode. Serialized requests only (no protocol-level batching, pipelining, or
 * concurrent in-flight reductions). Returns one surface line per input line.
 */
export async function runThanatosBatch(exprLines: string[]): Promise<string[]> {
  if (exprLines.length === 0) return [];
  const session = await getThanatosSession();
  try {
    const out: string[] = [];
    for (const line of exprLines) {
      const expr = parseSKI(line);
      const dag = toDagWire(expr);
      const resultDag = await session.reduceDag(dag);
      out.push(unparseSKI(fromDagWire(resultDag)));
    }
    return out;
  } finally {
    await session.close();
  }
}

Deno.test({
  name: "RESET after several reductions then REDUCE",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const session = await getThanatosSession();
    try {
      // Several REDUCEs to populate arena
      const r1 = await session.reduceDag(toDagWire(parseSKI("I S")));
      assertEquals(unparseSKI(fromDagWire(r1)), "S");
      const r2 = await session.reduceDag(toDagWire(parseSKI("K S K")));
      assertEquals(unparseSKI(fromDagWire(r2)), "S");
      await session.reset();
      // One more REDUCE after RESET proves arena was cleared and reducer still works
      const r3 = await session.reduceDag(toDagWire(parseSKI("I K")));
      assertEquals(unparseSKI(fromDagWire(r3)), "K");
    } finally {
      await session.close();
    }
  },
});

Deno.test({
  name: "daemon PING RESET STATS QUIT",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const session = await getThanatosSession();
    try {
      await session.ping();
      await session.reset();
      const statsLine = await session.stats();
      assert(
        statsLine.includes("top=") &&
          statsLine.includes("capacity=") &&
          statsLine.includes("total_nodes=") &&
          statsLine.includes("total_steps=") &&
          statsLine.includes("total_cons_allocs=") &&
          statsLine.includes("total_cont_allocs=") &&
          statsLine.includes("total_susp_allocs=") &&
          statsLine.includes("duplicate_lost_allocs=") &&
          statsLine.includes("hashcons_hits=") &&
          statsLine.includes("hashcons_misses=") &&
          statsLine.includes("events=") &&
          statsLine.includes("dropped="),
        "STATS missing expected fields: " + statsLine,
      );
    } finally {
      await session.close();
    }
  },
});

/**
 * Stage 8: Native IO support — same compiler binary emits same bytes as JS/WASM.
 * Runs writeOne 65 via thanatos batch mode and via JS evaluator; asserts stdout
 * bytes match.
 */
Deno.test({
  name: "native vs JS/WASM same stdout bytes (writeOne)",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const expr = apply(apply(WriteOne, { kind: "u8", value: 65 }), I);
    const dagLine = toDagWire(expr);

    const { ParallelArenaEvaluatorWasm } = await import(
      "../lib/evaluator/parallelArenaEvaluator.ts"
    );
    const evaluator = await ParallelArenaEvaluatorWasm.create(1);
    try {
      await evaluator.reduceAsync(expr);
      const jsStdout = await evaluator.readStdout(1);
      assertEquals(jsStdout.length, 1);
      assertEquals(jsStdout[0], 65);

      const proc = new Deno.Command(THANATOS_BIN, {
        args: ["--dag", String(TEST_NATIVE_WORKERS)],
        cwd: PROJECT_ROOT,
        stdin: "piped",
        stdout: "piped",
        stderr: "inherit",
      }).spawn();
      try {
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode(dagLine + "\n"));
        await writer.close();
        const { stdout: nativeStdout } = await proc.output();
        if (nativeStdout.length === 0) {
          console.error("nativeStdout is empty!");
        } else {
          console.error(
            "nativeStdout:",
            new TextDecoder().decode(nativeStdout),
          );
        }
        assertEquals(nativeStdout.length >= 1, true);
        assertEquals(nativeStdout[0], 65, "native first byte must match JS");
        assertEquals(
          nativeStdout.subarray(0, jsStdout.length),
          jsStdout,
          "native program stdout must equal JS program stdout",
        );
      } catch (e) {
        try {
          proc.kill();
        } catch { /* ignore */ }
        throw e;
      }
    } finally {
      evaluator.terminate();
    }
  },
});

/** Multiple writeOne on a single continuation spine must preserve program
 * order. Native batch mode should therefore emit ABC exactly, not merely some
 * permutation of those bytes.
 *
 * Semantics: the DAG decodes to (WriteOne 65)((WriteOne 66)((WriteOne 67)I)),
 * i.e. three causally ordered writeOne calls with continuations.
 *
 * Why stdout has more than 3 bytes: the thanatos binary in batch mode writes
 * (1) the arena stdout pump output (these 3 bytes) and (2) a textual line from
 * main.c (unparse_dag(result) + newline). We only assert on the first 3 bytes.
 *
 * DAG string (postorder): . U41 @0,1 . U42 @3,4 . U43 @6,7 I @8,9 @5,10 @2,11 */
Deno.test({
  name: "native IO - multiple writeOne ABC preserves sequential order",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const dagLine = ". U41 @0,1 . U42 @3,4 . U43 @6,7 I @8,9 @5,10 @2,11";
    for (let i = 0; i < 32; i++) {
      const proc = new Deno.Command(THANATOS_BIN, {
        args: ["--dag", String(TEST_NATIVE_WORKERS)],
        cwd: PROJECT_ROOT,
        stdin: "piped",
        stdout: "piped",
        stderr: "inherit",
      }).spawn();
      try {
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode(dagLine + "\n"));
        await writer.close();
        const { stdout } = await proc.output();
        assertEquals(stdout.length >= 3, true);
        const first3 = Array.from(stdout.subarray(0, 3));
        assertEquals(
          first3,
          [65, 66, 67],
          `run ${i + 1}: first three stdout bytes must preserve ABC order`,
        );
      } catch (e) {
        try {
          proc.kill();
        } catch { /* ignore */ }
        throw e;
      }
    }
  },
});

/** readOne with runtime stdin from --stdin-file; assert result line (no reduction error). */
Deno.test({
  name: "native IO - readOne with --stdin-file",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const tmpStdin = await Deno.makeTempFile();
    await Deno.writeFile(tmpStdin, new Uint8Array([65]));
    try {
      const expr = apply(ReadOne, I);
      const dagLine = toDagWire(expr);
      const proc = new Deno.Command(THANATOS_BIN, {
        args: ["--dag", "--stdin-file", tmpStdin, String(TEST_NATIVE_WORKERS)],
        cwd: PROJECT_ROOT,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      try {
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode(dagLine + "\n"));
        await writer.close();
        const { stdout, stderr, code } = await proc.output();
        const outText = new TextDecoder().decode(stdout);
        const errText = new TextDecoder().decode(stderr);
        assertEquals(code, 0, "exit 0");
        assertEquals(
          outText.includes("reduction error"),
          false,
          "must not report reduction error: " + errText,
        );
        assertEquals(
          outText.includes("U41") || outText.includes("65"),
          true,
          "result should reflect byte 65 (U41): " + outText,
        );
      } catch (e) {
        try {
          proc.kill();
        } catch { /* ignore */ }
        throw e;
      }
    } finally {
      await Deno.remove(tmpStdin);
    }
  },
});

/** readOne with empty runtime stdin file: native must block until data arrives,
 * matching the JS/WASM host contract more closely than the old EOF error path. */
Deno.test({
  name: "native IO - readOne blocks until --stdin-file receives data",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const tmpStdin = await Deno.makeTempFile();
    await Deno.writeFile(tmpStdin, new Uint8Array());
    try {
      const expr = apply(ReadOne, I);
      const dagLine = toDagWire(expr);
      const proc = new Deno.Command(THANATOS_BIN, {
        args: ["--dag", "--stdin-file", tmpStdin, String(TEST_NATIVE_WORKERS)],
        cwd: PROJECT_ROOT,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      try {
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode(dagLine + "\n"));
        await writer.close();

        const outputPromise = proc.output();
        const stateBeforeAppend = await Promise.race([
          outputPromise.then(() => "finished"),
          new Promise<"pending">((resolve) =>
            setTimeout(() => resolve("pending"), 50)
          ),
        ]);
        assertEquals(
          stateBeforeAppend,
          "pending",
          "READ_ONE should stay blocked while runtime stdin is empty",
        );

        await Deno.writeFile(tmpStdin, new Uint8Array([65]), { append: true });

        const { stdout, stderr, code } = await outputPromise;
        const outText = new TextDecoder().decode(stdout);
        const errText = new TextDecoder().decode(stderr);
        assertEquals(code, 0, "exit 0 after input arrives");
        assertEquals(
          outText.includes("reduction error"),
          false,
          "must not report reduction error: " + errText,
        );
        assertEquals(
          outText.includes("U41") || outText.includes("65"),
          true,
          "result should reflect byte 65 (U41): " + outText,
        );
      } catch (e) {
        try {
          proc.kill();
        } catch { /* ignore */ }
        throw e;
      }
    } finally {
      await Deno.remove(tmpStdin);
    }
  },
});

/** Interleaved read/write: read one byte, write it (echo); runtime stdin from file. */
Deno.test({
  name: "native IO - interleaved read/write echo",
  ignore: !thanatosAvailable(),
  fn: async () => {
    const tmpStdin = await Deno.makeTempFile();
    await Deno.writeFile(tmpStdin, new Uint8Array([88])); // 'X'
    try {
      const expr = apply(ReadOne, apply(apply(C, WriteOne), I));
      const dagLine = toDagWire(expr);
      const proc = new Deno.Command(THANATOS_BIN, {
        args: ["--dag", "--stdin-file", tmpStdin, String(TEST_NATIVE_WORKERS)],
        cwd: PROJECT_ROOT,
        stdin: "piped",
        stdout: "piped",
        stderr: "inherit",
      }).spawn();
      try {
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode(dagLine + "\n"));
        await writer.close();
        const { stdout } = await proc.output();
        assertEquals(stdout.length >= 1, true);
        assertEquals(stdout[0], 88, "echoed byte must be 88 (X)");
      } catch (e) {
        try {
          proc.kill();
        } catch { /* ignore */ }
        throw e;
      }
    } finally {
      await Deno.remove(tmpStdin);
    }
  },
});

Deno.test({
  name: "fromDagWire - error paths (coverage)",
  fn: () => {
    // Empty DAG
    assertThrows(() => fromDagWire(""), Error, "empty DAG");
    // Invalid U8 #u8(256)
    assertThrows(() => fromDagWire("#u8(256)"), Error, "invalid U8");
    // Invalid U8 UXY
    assertThrows(() => fromDagWire("UXY"), Error, "invalid U8");
    // Invalid app (missing comma)
    assertThrows(() => fromDagWire("@0"), Error, "invalid app");
    // Invalid app indices (out of bounds)
    assertThrows(() => fromDagWire("@0,0"), Error, "invalid app indices");
    // Invalid DAG token
    assertThrows(() => fromDagWire("X"), Error, "invalid DAG token");
  },
});

Deno.test({
  name: "dagCharToSym - error (coverage)",
  fn: () => {
    assertThrows(
      () => dagCharToSym("?"),
      Error,
      "invalid DAG terminal: ?",
    );
  },
});

Deno.test({
  name: "ThanatosSession - reduceDag error (coverage)",
  fn: async () => {
    const session = await getThanatosSession();
    try {
      await assertRejects(
        () => session.reduceDag("INVALID"),
        Error,
        "thanatos: parse error",
      );
    } finally {
      await session.close();
    }
  },
});

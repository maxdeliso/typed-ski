/**
 * Test harness for running SKI reduction via the native thanatos binary.
 * Uses a single long-lived daemon process (singleton). All tests share one thanatos;
 * runThanatosBatch sends expressions through the session with surface↔DAG conversion.
 */

import { assertEquals } from "std/assert";
import { existsSync } from "std/fs";
import { dirname, fromFileUrl, join } from "std/path";
import type { Evaluator } from "../lib/evaluator/evaluator.ts";
import type { SKIExpression } from "../lib/ski/expression.ts";
import { apply, unparseSKI } from "../lib/ski/expression.ts";
import { term } from "../lib/ski/terminal.ts";
import type { SKITerminalSymbol } from "../lib/ski/terminal.ts";
import { parseSKI } from "../lib/parser/ski.ts";

const __dirname = dirname(fromFileUrl(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

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
  function postorder(e: SKIExpression): void {
    if (e.kind === "non-terminal") {
      postorder(e.lft);
      postorder(e.rgt);
    }
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
      getSessionPromiseRef().current = null;
    }
  }
}

function defaultWorkerCount(): number {
  return typeof navigator !== "undefined" && navigator.hardwareConcurrency > 0
    ? navigator.hardwareConcurrency
    : 4;
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
  const out: string[] = [];
  for (const line of exprLines) {
    const expr = parseSKI(line);
    const dag = toDagWire(expr);
    const resultDag = await session.reduceDag(dag);
    out.push(unparseSKI(fromDagWire(resultDag)));
  }
  return out;
}

Deno.test({
  name: "RESET after several reductions then REDUCE",
  ignore: !thanatosAvailable(),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const session = await getThanatosSession();
    // Several REDUCEs to populate arena
    const r1 = await session.reduceDag(toDagWire(parseSKI("I S")));
    assertEquals(unparseSKI(fromDagWire(r1)), "S");
    const r2 = await session.reduceDag(toDagWire(parseSKI("K S K")));
    assertEquals(unparseSKI(fromDagWire(r2)), "S");
    await session.reset();
    // One more REDUCE after RESET proves arena was cleared and reducer still works
    const r3 = await session.reduceDag(toDagWire(parseSKI("I K")));
    assertEquals(unparseSKI(fromDagWire(r3)), "K");
  },
});

Deno.test({
  name: "daemon PING RESET STATS QUIT",
  ignore: !thanatosAvailable(),
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const session = await getThanatosSession();
    await session.ping();
    await session.reset();
    const statsLine = await session.stats();
    if (
      !statsLine.includes("top=") ||
      !statsLine.includes("capacity=") ||
      !statsLine.includes("events=") ||
      !statsLine.includes("dropped=")
    ) {
      throw new Error("STATS missing expected fields: " + statsLine);
    }
  },
});

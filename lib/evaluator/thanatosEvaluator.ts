import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SKIExpression } from "../ski/expression.ts";
import { unparseSKI } from "../ski/expression.ts";
import {
  fromTopoDagWire,
  toTopoDagWire,
  type TopoDagWireEncodeOptions,
  writeTopoDagWireAsync,
} from "../ski/topoDagWire.ts";
import type { Evaluator } from "./evaluator.ts";
import { TEST_TIMEOUT_MS } from "../constants.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..", "..");
const THANATOS_FILE_NAME =
  process.platform === "win32" ? "thanatos.exe" : "thanatos";
export const DEFAULT_THANATOS_TIMEOUT_MS = TEST_TIMEOUT_MS;

export function getDefaultTimeoutMs(): number {
  const envVal = process.env["THANATOS_TIMEOUT_MS"];
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_THANATOS_TIMEOUT_MS;
}

const MIN_WORKERS = 2;

export const THANATOS_BATCH_BROKER_URL_ENV = "THANATOS_BATCH_BROKER_URL";
export const THANATOS_BATCH_BROKER_TOKEN_ENV = "THANATOS_BATCH_BROKER_TOKEN";
export const THANATOS_BATCH_BROKER_TOKEN_HEADER = "x-thanatos-batch-token";

export type ThanatosBrokerConfig = {
  url: string;
  token: string;
};

export type ThanatosSessionOptions = {
  key?: string;
  workers?: number;
  binPath?: string;
  env?: Record<string, string>;
  broker?: ThanatosBrokerConfig;
  requestTimeoutMs?: number;
};

export type ThanatosEvaluatorOptions = ThanatosSessionOptions;

export type ThanatosReduceIoResult = {
  result: SKIExpression;
  stdout: Uint8Array;
};

export type BrokerRequest =
  | { op: "signal"; signal: string }
  | { op: "rawRequest"; line: string }
  | { op: "reduceDag"; dag: string }
  | { op: "reduceIo"; dag: string; stdinHex: string }
  | { op: "reduceFile"; dag: string; inPath: string; outPath: string }
  | { op: "reset" }
  | { op: "ping" }
  | { op: "stats" }
  | { op: "stats" };

export type BrokerResponse =
  | { ok: true; value?: string; stdoutHex?: string; resultDag?: string }
  | { ok: false; error: string };

type TailLock = {
  tail: Promise<void>;
};

type SharedSessionState = TailLock & {
  sessionPromise: Promise<ThanatosSession>;
};

export class ThanatosUnavailableError extends Error {
  public readonly checkedPaths: string[];

  constructor(checkedPaths: string[]) {
    super(
      [
        "thanatos daemon binary not found.",
        checkedPaths.length > 0
          ? `Checked: ${checkedPaths.join(", ")}.`
          : "No binary candidates were available.",
        "Build //:thanatos or set THANATOS_BIN.",
      ].join(" "),
    );
    this.name = "ThanatosUnavailableError";
    this.checkedPaths = checkedPaths;
  }
}

export interface ThanatosSession {
  start(workers?: number, env?: Record<string, string>): void;
  signal(signal: string): Promise<void>;
  rawRequest(line: string): Promise<string>;
  reduceDag(dag: string): Promise<string>;
  reduceDagChunks(chunks: Iterable<string>): Promise<string>;
  reduceExpr(
    expr: SKIExpression,
    options?: TopoDagWireEncodeOptions,
  ): Promise<string>;
  stepExpr(expr: SKIExpression, maxSteps: number): Promise<string>;
  reduceIo(
    dag: string,
    stdin: Uint8Array,
  ): Promise<{ stdout: Uint8Array; resultDag: string }>;
  reduceFile(dag: string, inPath: string, outPath: string): Promise<string>;
  reset(): Promise<void>;
  ping(): Promise<void>;
  stats(): Promise<string>;
  close(): Promise<void>;
}

export function defaultWorkerCount(): number {
  const detected =
    typeof navigator !== "undefined" && navigator.hardwareConcurrency > 0
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(MIN_WORKERS, Math.min(detected, 4));
}

export function getDefaultThanatosBinCandidates(): string[] {
  return [
    join(PROJECT_ROOT, "bazel-bin", "core", THANATOS_FILE_NAME),
    join(PROJECT_ROOT, "bin", THANATOS_FILE_NAME),
  ];
}

export const THANATOS_BIN =
  process.env["THANATOS_BIN"] ?? getDefaultThanatosBinCandidates()[0]!;

export function resolveThanatosBinPath(binPath?: string): {
  path: string | null;
  checkedPaths: string[];
} {
  const checkedPaths: string[] = [];
  if (binPath !== undefined) {
    checkedPaths.push(binPath);
    return { path: existsSync(binPath) ? binPath : null, checkedPaths };
  }

  const candidates = [
    process.env["THANATOS_BIN"],
    ...getDefaultThanatosBinCandidates(),
  ].filter((candidate): candidate is string => !!candidate);

  for (const candidate of candidates) {
    checkedPaths.push(candidate);
    if (existsSync(candidate)) {
      return { path: candidate, checkedPaths };
    }
  }

  return { path: null, checkedPaths };
}

export function thanatosAvailable(binPath?: string): boolean {
  return resolveThanatosBinPath(binPath).path !== null;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex === "" || hex === "-") {
    return new Uint8Array(0);
  }
  return new Uint8Array(
    (hex.match(/.{1,2}/g) ?? []).map((byte) => parseInt(byte, 16)),
  );
}

function debugLog(msg: string): void {
  if (process.env["THANATOS_DEBUG_LOGGING"] === "1") {
    console.error(msg);
  }
}

export async function withTailLock<T>(
  lock: TailLock,
  callback: () => Promise<T>,
): Promise<T> {
  const id = Math.random().toString(36).slice(2, 6);
  debugLog(`[lock ${id}] queueing`);
  const previous = lock.tail.catch((e) => {
    debugLog(`[lock ${id}] previous failed: ${e.message}`);
  });
  let release!: () => void;
  lock.tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    debugLog(`[lock ${id}] waiting for previous`);
    await previous;
    debugLog(`[lock ${id}] acquired; executing callback`);
    // Safety: ensure no single operation can hold the lock forever.
    // We use a very long timeout here as a last resort.
    const lockTimeoutMs = getDefaultTimeoutMs();

    let timeoutId: any;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new Error(
            `withTailLock: operation timed out after ${lockTimeoutMs}ms`,
          ),
        );
      }, lockTimeoutMs);
    });

    try {
      const result = await Promise.race([callback(), timeoutPromise]);
      debugLog(`[lock ${id}] callback finished`);
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  } finally {
    debugLog(`[lock ${id}] releasing`);
    release();
  }
}

function requestTimeoutMs(options: ThanatosSessionOptions): number {
  return options.requestTimeoutMs ?? getDefaultTimeoutMs();
}

function timeoutError(ms: number): Error {
  return new Error(`thanatos request timed out after ${ms}ms`);
}

export class DirectThanatosSession implements ThanatosSession {
  private child: ChildProcess | null = null;
  private lineChunks: Uint8Array[] = [];
  private lineBuffer = new Uint8Array(0);
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private dataWaiters: (() => void)[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    private readonly options: ThanatosSessionOptions = {},
    private readonly onFatal?: () => void,
  ) {}

  private resetIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
    }
    if (this.closed) return;
    this.idleTimer = setTimeout(() => {
      this.close().catch(() => {});
    }, getDefaultTimeoutMs());
  }

  start(workers?: number, env?: Record<string, string>): void {
    if (this.child !== null) {
      this.resetIdleTimer();
      return;
    }
    if (this.closed) throw new Error("ThanatosSession closed");

    const resolved = resolveThanatosBinPath(this.options.binPath);
    if (resolved.path === null) {
      throw new ThanatosUnavailableError(resolved.checkedPaths);
    }

    const workerCount = workers ?? this.options.workers ?? defaultWorkerCount();
    this.child = spawn(resolved.path, [String(workerCount)], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...this.options.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.resetIdleTimer();

    this.child.stdout?.on("data", (data: Uint8Array) => {
      this.lineChunks.push(data);
      this.notifyData();
    });
    this.child.stdin?.on("error", (err: Error) => {
      if (!this.closed) {
        this.fail(err);
      }
    });
    this.child.stdout?.on("error", (err: Error) => {
      if (!this.closed) {
        this.fail(err);
      }
    });
    this.child.stdout?.on("close", () => {
      this.notifyData();
    });

    this.child.on("error", (err: Error) => {
      this.fail(err);
    });
    this.child.on("exit", () => {
      this.notifyData();
    });
  }

  private notifyData(): void {
    const waiters = this.dataWaiters;
    this.dataWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  private async waitForData(): Promise<void> {
    return new Promise((resolve) => {
      this.dataWaiters.push(resolve);
    });
  }

  async signal(signal: string): Promise<void> {
    if (this.child === null) {
      throw new Error("ThanatosSession not started");
    }
    if (this.closed) throw new Error("ThanatosSession closed");
    this.child.kill(signal as any);
  }

  private fail(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (child !== null) {
      child.kill();
    }
    this.notifyData();
    this.onFatal?.();
    if (error) {
      this.pending = Promise.reject(error);
      this.pending.catch(() => {});
    }
  }

  private async withTimeout<T>(operation: () => Promise<T>): Promise<T> {
    const ms = requestTimeoutMs(this.options);
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = timeoutError(ms);
        this.fail(error);
        reject(error);
      }, ms);
    });

    try {
      return await Promise.race([operation(), timeout]);
    } finally {
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async writePart(part: string): Promise<void> {
    if (part.length === 0) {
      return;
    }
    if (
      this.child === null ||
      this.child.stdin === null ||
      this.child.stdout === null
    ) {
      throw new Error("ThanatosSession not started");
    }
    if (this.closed) throw new Error("ThanatosSession closed");
    if (this.child.stdin.write(part)) {
      return;
    }
    await new Promise((resolve, reject) => {
      const currentChild = this.child;
      const onError = (error: Error) => {
        currentChild?.stdin?.off("drain", onDrain);
        reject(error);
      };
      const onDrain = () => {
        currentChild?.stdin?.off("error", onError);
        resolve(null);
      };
      this.child?.stdin?.once("error", onError);
      this.child?.stdin?.once("drain", onDrain);
    });
  }

  private async readResponseLine(): Promise<string> {
    const decoder = new TextDecoder();
    while (true) {
      if (this.closed) throw new Error("ThanatosSession closed");

      if (this.lineChunks.length > 0) {
        const totalLen = this.lineChunks.reduce(
          (acc, c) => acc + c.length,
          this.lineBuffer.length,
        );
        const merged = new Uint8Array(totalLen);
        merged.set(this.lineBuffer);
        let offset = this.lineBuffer.length;
        for (const chunk of this.lineChunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        this.lineBuffer = merged;
        this.lineChunks = [];
      }

      const newlineIndex = this.lineBuffer.indexOf(0x0a);
      if (newlineIndex >= 0) {
        const response = decoder
          .decode(this.lineBuffer.subarray(0, newlineIndex))
          .replace(/\r$/, "");
        this.lineBuffer = this.lineBuffer.subarray(newlineIndex + 1);
        return response;
      }

      if (
        this.child === null ||
        this.child.killed ||
        this.child.exitCode !== null
      ) {
        throw new Error("thanatos daemon exited");
      }

      await this.waitForData();
    }
  }

  private async request(line: string): Promise<string> {
    const id = Math.random().toString(36).slice(2, 6);
    debugLog(
      `[session ${id}] request: ${line.slice(0, 50)}${line.length > 50 ? "..." : ""}`,
    );
    this.start();
    await this.writePart(line);
    await this.writePart("\n");
    const response = await this.readResponseLine();
    debugLog(
      `[session ${id}] response: ${response.slice(0, 50)}${response.length > 50 ? "..." : ""}`,
    );
    this.resetIdleTimer();
    return response;
  }

  private async requestChunks(chunks: Iterable<string>): Promise<string> {
    const id = Math.random().toString(36).slice(2, 6);
    debugLog(`[session ${id}] requestChunks start`);
    this.start();
    for (const chunk of chunks) {
      await this.writePart(chunk);
    }
    await this.writePart("\n");
    const response = await this.readResponseLine();
    debugLog(
      `[session ${id}] response: ${response.slice(0, 50)}${response.length > 50 ? "..." : ""}`,
    );
    this.resetIdleTimer();
    return response;
  }

  private serialRequest(line: string): Promise<string> {
    const previous = this.pending.catch(() => {});
    let resolveNext!: () => void;
    this.pending = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    const result = (async () => {
      await previous;
      return await this.withTimeout(() => this.request(line));
    })();
    void result.then(resolveNext, resolveNext);
    return result;
  }

  private serialChunkRequest(chunks: Iterable<string>): Promise<string> {
    const previous = this.pending.catch(() => {});
    let resolveNext!: () => void;
    this.pending = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    const result = (async () => {
      await previous;
      return await this.withTimeout(() => this.requestChunks(chunks));
    })();
    void result.then(resolveNext, resolveNext);
    return result;
  }

  private serialExprRequest(
    prefix: string,
    expr: SKIExpression,
    options: TopoDagWireEncodeOptions = {},
  ): Promise<string> {
    const previous = this.pending.catch(() => {});
    let resolveNext!: () => void;
    this.pending = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    const result = (async () => {
      await previous;
      return await this.withTimeout(async () => {
        this.start();
        await this.writePart(prefix);
        await writeTopoDagWireAsync(
          expr,
          async (chunk) => {
            await this.writePart(chunk);
          },
          options,
        );
        await this.writePart("\n");
        const response = await this.readResponseLine();
        this.resetIdleTimer();
        return response;
      });
    })();
    void result.then(resolveNext, resolveNext);
    return result;
  }

  async rawRequest(line: string): Promise<string> {
    return await this.serialRequest(line);
  }

  async reduceDag(dag: string): Promise<string> {
    const response = await this.serialRequest("REDUCE " + dag.trim());
    return parseDagResponse(response);
  }

  async reduceDagChunks(chunks: Iterable<string>): Promise<string> {
    function* requestChunks(): Generator<string> {
      yield "REDUCE ";
      for (const chunk of chunks) {
        yield chunk;
      }
    }
    return parseDagResponse(await this.serialChunkRequest(requestChunks()));
  }

  async reduceExpr(
    expr: SKIExpression,
    options: TopoDagWireEncodeOptions = {},
  ): Promise<string> {
    return parseDagResponse(
      await this.serialExprRequest("REDUCE ", expr, options),
    );
  }

  async stepExpr(expr: SKIExpression, maxSteps: number): Promise<string> {
    return parseDagResponse(
      await this.serialExprRequest(`STEP ${maxSteps >>> 0} `, expr),
    );
  }

  async reduceIo(
    dag: string,
    stdin: Uint8Array,
  ): Promise<{ stdout: Uint8Array; resultDag: string }> {
    let stdinHex = bytesToHex(stdin);
    if (stdinHex === "") stdinHex = "-";
    const response = await this.serialRequest(
      "REDUCE_IO " + stdinHex + " " + dag.trim(),
    );
    return parseIoResponse(response);
  }

  async reduceFile(
    dag: string,
    inPath: string,
    outPath: string,
  ): Promise<string> {
    const response = await this.serialRequest(
      "REDUCE_FILE " + inPath + " " + outPath + " " + dag.trim(),
    );
    return parseDagResponse(response);
  }

  async reset(): Promise<void> {
    const response = await this.serialRequest("RESET");
    if (response !== "OK") throw new Error("thanatos: " + response);
  }

  async ping(): Promise<void> {
    const response = await this.serialRequest("PING");
    if (response !== "OK") throw new Error("thanatos: " + response);
  }

  async stats(): Promise<string> {
    const response = await this.serialRequest("STATS");
    if (!response.startsWith("OK ")) throw new Error("thanatos: " + response);
    return response;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      if (this.child !== null && this.child.stdin !== null) {
        // Try to be nice, but don't wait too long.
        await Promise.race([
          this.serialRequest("QUIT"),
          new Promise((r) => setTimeout(r, 1000)),
        ]).catch(() => {});
      }
    } finally {
      this.abort();
    }
  }

  abort(): void {
    if (this.closed && this.child === null) return;
    this.closed = true;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (child !== null) {
      child.kill("SIGKILL");
    }
    this.notifyData();
    const error = new Error("ThanatosSession aborted");
    this.pending = Promise.reject(error);
    this.pending.catch(() => {});
    this.onFatal?.();
  }
}

export class BrokerThanatosSession implements ThanatosSession {
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly options: ThanatosSessionOptions = {},
  ) {}

  start(_workers?: number, _env?: Record<string, string>): void {
    // The broker owner controls daemon startup.
  }

  async signal(signal: string): Promise<void> {
    this.ensureOpen();
    await this.request<void>({ op: "signal", signal });
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error("ThanatosSession closed");
    }
  }

  private async request<T>(payload: BrokerRequest): Promise<T> {
    const id = Math.random().toString(36).slice(2, 6);
    debugLog(`[broker-client ${id}] request op=${payload.op} to ${this.url}`);
    this.ensureOpen();
    const ms = requestTimeoutMs(this.options);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ms);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [THANATOS_BATCH_BROKER_TOKEN_HEADER]: this.token,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      let body: BrokerResponse | null = null;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        try {
          body = (await response.json()) as BrokerResponse;
        } catch {
          body = null;
        }
      }
      if (!response.ok) {
        if (body !== null && !body.ok) {
          throw new Error(body.error);
        }
        throw new Error(
          `thanatos broker request failed with status ${response.status}`,
        );
      }
      if (body === null) {
        throw new Error("thanatos broker returned invalid JSON");
      }
      if (!body.ok) {
        throw new Error(body.error);
      }
      return (body.value ?? body) as T;
    } catch (error) {
      if ((error as { name?: string }).name === "AbortError") {
        throw timeoutError(ms);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async rawRequest(line: string): Promise<string> {
    return await this.request<string>({ op: "rawRequest", line });
  }

  async reduceDag(dag: string): Promise<string> {
    return await this.request<string>({ op: "reduceDag", dag });
  }

  async reduceDagChunks(chunks: Iterable<string>): Promise<string> {
    let dag = "";
    for (const chunk of chunks) {
      dag += chunk;
    }
    return await this.reduceDag(dag);
  }

  async reduceExpr(
    expr: SKIExpression,
    options: TopoDagWireEncodeOptions = {},
  ): Promise<string> {
    const chunks: string[] = [];
    await writeTopoDagWireAsync(
      expr,
      async (chunk) => {
        chunks.push(chunk);
      },
      options,
    );
    return await this.reduceDagChunks(chunks);
  }

  async stepExpr(expr: SKIExpression, maxSteps: number): Promise<string> {
    return await this.rawRequest(
      `STEP ${maxSteps >>> 0} ${toTopoDagWire(expr)}`,
    ).then(parseDagResponse);
  }

  async reduceIo(
    dag: string,
    stdin: Uint8Array,
  ): Promise<{ stdout: Uint8Array; resultDag: string }> {
    const body = await this.request<{ stdoutHex?: string; resultDag?: string }>(
      { op: "reduceIo", dag, stdinHex: bytesToHex(stdin) },
    );
    return {
      stdout: hexToBytes(body.stdoutHex ?? ""),
      resultDag: body.resultDag ?? "",
    };
  }

  async reduceFile(
    dag: string,
    inPath: string,
    outPath: string,
  ): Promise<string> {
    return await this.request<string>({
      op: "reduceFile",
      dag,
      inPath,
      outPath,
    });
  }

  async reset(): Promise<void> {
    await this.request<void>({ op: "reset" });
  }

  async ping(): Promise<void> {
    await this.request<void>({ op: "ping" });
  }

  async stats(): Promise<string> {
    return await this.request<string>({ op: "stats" });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function parseDagResponse(response: string): string {
  if (response.startsWith("OK ")) return response.slice(3).trim();
  if (response === "OK") return "";
  if (response.startsWith("ERR ")) {
    throw new Error("thanatos: " + response.slice(4));
  }
  throw new Error("thanatos: unexpected " + response);
}

function parseIoResponse(response: string): {
  stdout: Uint8Array;
  resultDag: string;
} {
  if (!response.startsWith("OK ")) {
    if (response.startsWith("ERR ")) {
      throw new Error("thanatos: " + response.slice(4));
    }
    throw new Error("thanatos: unexpected " + response);
  }
  const parts = response.slice(3).trim().split(/\s+/);
  if (parts.length < 1) throw new Error("thanatos: missing result in OK");
  const stdoutHex = parts[0]!;
  const resultDag = parts.slice(1).join(" ");
  return { stdout: hexToBytes(stdoutHex), resultDag };
}

function brokerConfigFromEnv(): ThanatosBrokerConfig | null {
  const url = process.env[THANATOS_BATCH_BROKER_URL_ENV];
  const token = process.env[THANATOS_BATCH_BROKER_TOKEN_ENV];
  if (!url || !token) {
    return null;
  }
  return { url, token };
}

function resolveBrokerConfig(
  options: ThanatosSessionOptions = {},
): ThanatosBrokerConfig | null {
  return options.broker ?? brokerConfigFromEnv();
}

export function usingThanatosBatchBroker(): boolean {
  return brokerConfigFromEnv() !== null;
}

export function getBatchBrokerEnvVarNames(): {
  url: string;
  token: string;
} {
  return {
    url: THANATOS_BATCH_BROKER_URL_ENV,
    token: THANATOS_BATCH_BROKER_TOKEN_ENV,
  };
}

const SESSION_REGISTRY_KEY = "__thanatosSessionRegistry";

function getSessionRegistry(): Map<string, SharedSessionState> {
  const g = globalThis as any;
  if (g[SESSION_REGISTRY_KEY]) {
    return g[SESSION_REGISTRY_KEY];
  }
  const created = new Map<string, SharedSessionState>();
  g[SESSION_REGISTRY_KEY] = created;
  return created;
}

function sessionRegistryKey(options: ThanatosSessionOptions = {}): string {
  const broker = resolveBrokerConfig(options);
  if (broker) {
    return JSON.stringify({
      brokerUrl: broker.url,
      brokerToken: broker.token,
      timeout: requestTimeoutMs(options),
    });
  }
  const envEntries = Object.entries(options.env ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const resolved = resolveThanatosBinPath(options.binPath);
  return JSON.stringify({
    key: options.key ?? "",
    workers: options.workers ?? defaultWorkerCount(),
    binPath: resolved.path ?? options.binPath ?? process.env["THANATOS_BIN"],
    env: envEntries,
    timeout: requestTimeoutMs(options),
  });
}

function getSharedSessionState(
  options: ThanatosSessionOptions = {},
): SharedSessionState {
  const broker = resolveBrokerConfig(options);
  if (broker === null) {
    const resolved = resolveThanatosBinPath(options.binPath);
    if (resolved.path === null) {
      throw new ThanatosUnavailableError(resolved.checkedPaths);
    }
  }

  const registry = getSessionRegistry();
  const key = sessionRegistryKey(options);
  const existing = registry.get(key);
  if (existing) {
    return existing;
  }

  const clearState = () => {
    if (registry.get(key) === state) {
      registry.delete(key);
    }
  };

  const state: SharedSessionState = {
    sessionPromise: Promise.resolve().then(() => {
      if (broker) {
        return new BrokerThanatosSession(broker.url, broker.token, options);
      }
      return new DirectThanatosSession(options, clearState);
    }),
    tail: Promise.resolve(),
  };

  state.sessionPromise.catch(clearState);
  registry.set(key, state);
  ensureSignalListeners();
  return state;
}

function onProcessSignal(): void {
  void closeThanatosSessions();
}

let signalListenersRegistered = false;

function ensureSignalListeners(): void {
  if (signalListenersRegistered) return;
  process.on("SIGINT", onProcessSignal);
  process.on("SIGTERM", onProcessSignal);
  signalListenersRegistered = true;
}

function removeSignalListeners(): void {
  if (!signalListenersRegistered) return;
  try {
    process.off("SIGINT", onProcessSignal);
  } catch {
    /* ignore */
  }
  try {
    process.off("SIGTERM", onProcessSignal);
  } catch {
    /* ignore */
  }
  signalListenersRegistered = false;
}

export function getThanatosSession(
  options: ThanatosSessionOptions = {},
): Promise<ThanatosSession> {
  return getSharedSessionState(options).sessionPromise;
}

export async function withThanatosSession<T>(
  callback: (session: ThanatosSession) => Promise<T>,
  options: ThanatosSessionOptions = {},
): Promise<T> {
  const id = Math.random().toString(36).slice(2, 6);
  debugLog(`[withThanatosSession ${id}] start`);
  const state = getSharedSessionState(options);
  const result = await withTailLock(state, async () => {
    debugLog(`[withThanatosSession ${id}] acquired lock`);
    const session = await state.sessionPromise;
    return await callback(session);
  });
  debugLog(`[withThanatosSession ${id}] finished`);
  return result;
}

export async function closeThanatosSessions(): Promise<void> {
  if (usingThanatosBatchBroker()) {
    return;
  }

  const registry = getSessionRegistry();
  const states = Array.from(registry.values());
  registry.clear();
  await Promise.all(
    states.map(async (state) => {
      const session = await state.sessionPromise.catch(() => null);
      if (session !== null) {
        await session.close().catch(() => {});
      }
    }),
  );
  removeSignalListeners();
}

export class ThanatosEvaluator implements Evaluator {
  private readonly options: ThanatosEvaluatorOptions;

  public constructor(options: ThanatosEvaluatorOptions = {}) {
    this.options = options;
    getSharedSessionState(options);
  }

  async reduce(expr: SKIExpression, maxSteps?: number): Promise<SKIExpression> {
    const resultDag = await this.withReset(async (session) => {
      if (maxSteps === undefined) {
        return await session.reduceExpr(expr);
      }
      try {
        return await session.stepExpr(expr, maxSteps);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "thanatos: runtime-control-ptr"
        ) {
          return await session.reduceExpr(expr);
        }
        throw error;
      }
    });
    return fromTopoDagWire(resultDag);
  }

  async step(
    expr: SKIExpression,
  ): Promise<{ altered: boolean; expr: SKIExpression }> {
    const next = await this.reduce(expr, 1);
    return {
      altered: unparseSKI(next) !== unparseSKI(expr),
      expr: next,
    };
  }

  async reduceWithIo(
    expr: SKIExpression,
    stdin: Uint8Array = new Uint8Array(0),
  ): Promise<ThanatosReduceIoResult> {
    const { resultDag, stdout } = await this.withReset(
      async (session) => await session.reduceIo(toTopoDagWire(expr), stdin),
    );
    return { result: fromTopoDagWire(resultDag), stdout };
  }

  async terminate(): Promise<void> {
    await closeThanatosSessions();
  }

  private async withReset<T>(
    callback: (session: ThanatosSession) => Promise<T>,
  ): Promise<T> {
    return await withThanatosSession(async (session) => {
      await session.reset();
      try {
        return await callback(session);
      } finally {
        await session.reset().catch(() => {});
      }
    }, this.options);
  }
}

export async function createThanatosEvaluator(
  options: ThanatosEvaluatorOptions = {},
): Promise<ThanatosEvaluator> {
  return new ThanatosEvaluator(options);
}

export const createArenaEvaluator = createThanatosEvaluator;

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { SKIExpression } from "../../lib/ski/expression.ts";
import {
  type TopoDagWireEncodeOptions,
  writeTopoDagWireAsync,
} from "../../lib/ski/topoDagWire.ts";
import {
  defaultWorkerCount,
  PROJECT_ROOT,
  THANATOS_BIN,
  thanatosAvailable,
} from "./config.ts";

const THANATOS_BATCH_BROKER_URL_ENV = "THANATOS_BATCH_BROKER_URL";
const THANATOS_BATCH_BROKER_TOKEN_ENV = "THANATOS_BATCH_BROKER_TOKEN";
const THANATOS_BATCH_BROKER_TOKEN_HEADER = "x-thanatos-batch-token";
const THANATOS_BATCH_BROKER_INTERNAL_ERROR = "Internal error";

export type BatchThanatosSessionOptions = {
  key?: string;
  workers?: number;
  env?: Record<string, string>;
  broker?: BatchBrokerConfig;
  resetBefore?: boolean;
  resetAfter?: boolean;
};

export type StartedThanatosBatchBroker = {
  allowNet: string;
  env: Record<string, string>;
  close: () => Promise<void>;
};

type TailLock = {
  tail: Promise<void>;
};

type SharedSessionState = TailLock & {
  sessionPromise: Promise<ThanatosSession>;
};

type BatchBrokerConfig = {
  url: string;
  token: string;
};

type BrokerRequest =
  | { op: "signal"; signal: string }
  | { op: "rawRequest"; line: string }
  | { op: "reduceDag"; dag: string }
  | { op: "reduceIo"; dag: string; stdinHex: string }
  | { op: "reduceFile"; dag: string; inPath: string; outPath: string }
  | { op: "reset" }
  | { op: "ping" }
  | { op: "stats" }
  | { op: "traceDump" };

type BrokerResponse =
  | { ok: true; value?: string; stdoutHex?: string; resultDag?: string }
  | { ok: false; error: string };

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
  reduceIo(
    dag: string,
    stdin: Uint8Array,
  ): Promise<{ stdout: Uint8Array; resultDag: string }>;
  reduceFile(dag: string, inPath: string, outPath: string): Promise<string>;
  reset(): Promise<void>;
  ping(): Promise<void>;
  stats(): Promise<string>;
  traceDump(): Promise<void>;
  close(): Promise<void>;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (hex === "" || hex === "-") {
    return new Uint8Array(0);
  }
  return new Uint8Array(
    (hex.match(/.{1,2}/g) ?? []).map((byte) => parseInt(byte, 16)),
  );
}

class DirectThanatosSession implements ThanatosSession {
  private child: any = null;
  private lineBuffer = new Uint8Array(0);
  private pending: Promise<void> = Promise.resolve();
  private closed = false;

  start(workers?: number, env?: Record<string, string>): void {
    if (this.child != null) return;
    if (!thanatosAvailable()) throw new Error("thanatos binary not found");
    const workerCount = workers ?? defaultWorkerCount();

    this.child = spawn(THANATOS_BIN, [String(workerCount)], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });

    this.child.stdout.on("data", (data: Uint8Array) => {
      const merged = new Uint8Array(this.lineBuffer.length + data.length);
      merged.set(this.lineBuffer);
      merged.set(data, this.lineBuffer.length);
      this.lineBuffer = merged;
    });

    this.child.on("error", (err: Error) => {
      console.error("thanatos child process error:", err);
    });
  }

  async signal(signal: string): Promise<void> {
    if (this.child == null) {
      throw new Error("ThanatosSession not started");
    }
    if (this.closed) throw new Error("ThanatosSession closed");
    this.child.kill(signal as any);
    return Promise.resolve();
  }

  private async writePart(part: string): Promise<void> {
    if (part.length === 0) {
      return;
    }
    if (
      this.child == null ||
      this.child.stdin == null ||
      this.child.stdout == null
    ) {
      throw new Error("ThanatosSession not started");
    }
    if (this.closed) throw new Error("ThanatosSession closed");
    if (this.child.stdin.write(part)) {
      return;
    }
    await new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        this.child.stdin.off("drain", onDrain);
        reject(error);
      };
      const onDrain = () => {
        this.child.stdin.off("error", onError);
        resolve(null);
      };
      this.child.stdin.once("error", onError);
      this.child.stdin.once("drain", onDrain);
    });
  }

  private async readResponseLine(): Promise<string> {
    if (
      this.child == null ||
      this.child.stdin == null ||
      this.child.stdout == null
    ) {
      throw new Error("ThanatosSession not started");
    }
    if (this.closed) throw new Error("ThanatosSession closed");

    const decoder = new TextDecoder();
    while (true) {
      const newlineIndex = this.lineBuffer.indexOf(0x0a);
      if (newlineIndex >= 0) {
        const response = decoder
          .decode(this.lineBuffer.subarray(0, newlineIndex))
          .replace(/\r$/, "");
        this.lineBuffer = this.lineBuffer.subarray(newlineIndex + 1);
        return response;
      }

      // Wait for more data
      await new Promise((resolve) => {
        const onData = () => {
          this.child.stdout.removeListener("data", onData);
          resolve(null);
        };
        this.child.stdout.on("data", onData);
      });

      if (this.child.killed || this.child.exitCode !== null) {
        throw new Error("thanatos daemon exited");
      }
    }
  }

  private async request(line: string): Promise<string> {
    await this.writePart(line);
    await this.writePart("\n");
    return await this.readResponseLine();
  }

  private async requestChunks(chunks: Iterable<string>): Promise<string> {
    for (const chunk of chunks) {
      await this.writePart(chunk);
    }
    await this.writePart("\n");
    return await this.readResponseLine();
  }

  private serialRequest(line: string): Promise<string> {
    const previous = this.pending;
    let resolveNext!: () => void;
    this.pending = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    const result = previous.then(() => this.request(line));
    result.finally(() => resolveNext());
    return result;
  }

  private serialChunkRequest(chunks: Iterable<string>): Promise<string> {
    const previous = this.pending;
    let resolveNext!: () => void;
    this.pending = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    const result = previous.then(() => this.requestChunks(chunks));
    result.finally(() => resolveNext());
    return result;
  }

  private serialExprRequest(
    expr: SKIExpression,
    options: TopoDagWireEncodeOptions,
  ): Promise<string> {
    const previous = this.pending;
    let resolveNext!: () => void;
    this.pending = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });
    const result = previous.then(async () => {
      await this.writePart("REDUCE ");
      await writeTopoDagWireAsync(
        expr,
        async (chunk) => {
          await this.writePart(chunk);
        },
        options,
      );
      await this.writePart("\n");
      return await this.readResponseLine();
    });
    result.finally(() => resolveNext());
    return result;
  }

  async rawRequest(line: string): Promise<string> {
    this.start();
    return await this.serialRequest(line);
  }

  async reduceDag(dag: string): Promise<string> {
    this.start();
    const response = await this.serialRequest("REDUCE " + dag.trim());
    if (response.startsWith("OK ")) return response.slice(3).trim();
    if (response === "OK") return "";
    if (response.startsWith("ERR ")) {
      throw new Error("thanatos: " + response.slice(4));
    }
    throw new Error("thanatos: unexpected " + response);
  }

  async reduceDagChunks(chunks: Iterable<string>): Promise<string> {
    this.start();
    function* requestChunks(): Generator<string> {
      yield "REDUCE ";
      for (const chunk of chunks) {
        yield chunk;
      }
    }
    const response = await this.serialChunkRequest(requestChunks());
    if (response.startsWith("OK ")) return response.slice(3).trim();
    if (response === "OK") return "";
    if (response.startsWith("ERR ")) {
      throw new Error("thanatos: " + response.slice(4));
    }
    throw new Error("thanatos: unexpected " + response);
  }

  async reduceExpr(
    expr: SKIExpression,
    options: TopoDagWireEncodeOptions = {},
  ): Promise<string> {
    this.start();
    const response = await this.serialExprRequest(expr, options);
    if (response.startsWith("OK ")) return response.slice(3).trim();
    if (response === "OK") return "";
    if (response.startsWith("ERR ")) {
      throw new Error("thanatos: " + response.slice(4));
    }
    throw new Error("thanatos: unexpected " + response);
  }

  async reduceIo(
    dag: string,
    stdin: Uint8Array,
  ): Promise<{ stdout: Uint8Array; resultDag: string }> {
    this.start();
    let stdinHex = bytesToHex(stdin);
    if (stdinHex === "") stdinHex = "-";
    const response = await this.serialRequest(
      "REDUCE_IO " + stdinHex + " " + dag.trim(),
    );
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

  async reduceFile(
    dag: string,
    inPath: string,
    outPath: string,
  ): Promise<string> {
    this.start();
    const response = await this.serialRequest(
      "REDUCE_FILE " + inPath + " " + outPath + " " + dag.trim(),
    );
    if (!response.startsWith("OK ")) {
      if (response.startsWith("ERR ")) {
        throw new Error("thanatos: " + response.slice(4));
      }
      throw new Error("thanatos: unexpected " + response);
    }
    return response.slice(3).trim();
  }

  async reset(): Promise<void> {
    this.start();
    const response = await this.serialRequest("RESET");
    if (response !== "OK") throw new Error("thanatos: " + response);
  }

  async ping(): Promise<void> {
    this.start();
    const response = await this.serialRequest("PING");
    if (response !== "OK") throw new Error("thanatos: " + response);
  }

  async stats(): Promise<string> {
    this.start();
    const response = await this.serialRequest("STATS");
    if (!response.startsWith("OK ")) throw new Error("thanatos: " + response);
    return response;
  }

  async traceDump(): Promise<void> {
    this.start();
    const response = await this.serialRequest("TRACE_DUMP");
    if (response !== "OK") throw new Error("thanatos: " + response);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const child = this.child;
    try {
      if (this.child != null && this.child.stdin != null) {
        await this.serialRequest("QUIT");
      }
    } catch {
      // daemon may have exited; ignore
    } finally {
      this.closed = true;
      if (child != null) {
        child.kill();
      }
      this.child = null;
    }
  }
}

class BrokerThanatosSession implements ThanatosSession {
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  start(_workers?: number, _env?: Record<string, string>): void {
    // The batch runner owns the broker-backed Thanatos session.
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
    this.ensureOpen();
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [THANATOS_BATCH_BROKER_TOKEN_HEADER]: this.token,
      },
      body: JSON.stringify(payload),
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

  async traceDump(): Promise<void> {
    await this.request<void>({ op: "traceDump" });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

async function withTailLock<T>(
  lock: TailLock,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = lock.tail.catch(() => {});
  let release!: () => void;
  lock.tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await callback();
  } finally {
    release();
  }
}

function brokerConfigFromEnv(): BatchBrokerConfig | null {
  const url = process.env[THANATOS_BATCH_BROKER_URL_ENV];
  const token = process.env[THANATOS_BATCH_BROKER_TOKEN_ENV];
  if (!url || !token) {
    return null;
  }
  return { url, token };
}

function resolveBrokerConfig(
  options: BatchThanatosSessionOptions = {},
): BatchBrokerConfig | null {
  return options.broker ?? brokerConfigFromEnv();
}

async function handleBrokerRequest(
  req: any,
  res: any,
  session: DirectThanatosSession,
  token: string,
  lock: TailLock,
): Promise<void> {
  if (req.method !== "POST") {
    res.writeHead(405).end("Method Not Allowed");
    return;
  }
  if (req.headers[THANATOS_BATCH_BROKER_TOKEN_HEADER.toLowerCase()] !== token) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }

  try {
    const payload = JSON.parse(body) as BrokerRequest;
    const response = await withTailLock(
      lock,
      async (): Promise<BrokerResponse> => {
        switch (payload.op) {
          case "signal":
            session.signal(payload.signal);
            return { ok: true };
          case "rawRequest":
            return { ok: true, value: await session.rawRequest(payload.line) };
          case "reduceDag":
            return { ok: true, value: await session.reduceDag(payload.dag) };
          case "reduceIo": {
            const result = await session.reduceIo(
              payload.dag,
              hexToBytes(payload.stdinHex),
            );
            return {
              ok: true,
              stdoutHex: bytesToHex(result.stdout),
              resultDag: result.resultDag,
            };
          }
          case "reduceFile":
            return {
              ok: true,
              value: await session.reduceFile(
                payload.dag,
                payload.inPath,
                payload.outPath,
              ),
            };
          case "reset":
            await session.reset();
            return { ok: true };
          case "ping":
            await session.ping();
            return { ok: true };
          case "stats":
            return { ok: true, value: await session.stats() };
          case "traceDump":
            await session.traceDump();
            return { ok: true };
        }
      },
    );
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(response));
  } catch (error) {
    console.error("[thanatos harness] broker request failed", error);
    res.writeHead(500, { "content-type": "application/json" }).end(
      JSON.stringify({
        ok: false,
        error: THANATOS_BATCH_BROKER_INTERNAL_ERROR,
      }),
    );
  }
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

export function startThanatosBatchBroker(
  options: BatchThanatosSessionOptions = {},
): Promise<StartedThanatosBatchBroker> {
  if (!thanatosAvailable()) {
    throw new Error("thanatos binary not found");
  }

  const session = new DirectThanatosSession();
  session.start(options.workers ?? defaultWorkerCount(), options.env);

  const lock: TailLock = { tail: Promise.resolve() };
  const token = randomUUID();
  const server = createServer((req, res) =>
    handleBrokerRequest(req, res, session, token, lock),
  );

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      const brokerUrl = `http://127.0.0.1:${addr.port}`;

      resolve({
        allowNet: `127.0.0.1:${addr.port}`,
        env: {
          ...(options.env ?? {}),
          [THANATOS_BATCH_BROKER_URL_ENV]: brokerUrl,
          [THANATOS_BATCH_BROKER_TOKEN_ENV]: token,
        },
        close: async () => {
          await new Promise((r) => server.close(() => r(null)));
          await session.close().catch(() => {});
        },
      });
    });
  });
}

const THANATOS_SESSION_REGISTRY_KEY = "__thanatosSessionRegistry";

declare global {
  var __thanatosSessionRegistry: Map<string, SharedSessionState> | undefined;
}

function getSessionRegistry(): Map<string, SharedSessionState> {
  if (globalThis.__thanatosSessionRegistry) {
    return globalThis.__thanatosSessionRegistry;
  }
  const created = new Map<string, SharedSessionState>();
  globalThis.__thanatosSessionRegistry = created;
  return created;
}

function sessionRegistryKey(options: BatchThanatosSessionOptions = {}): string {
  const broker = resolveBrokerConfig(options);
  if (broker) {
    return JSON.stringify({
      brokerUrl: broker.url,
      brokerToken: broker.token,
    });
  }
  const envEntries = Object.entries(options.env ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return JSON.stringify({
    key: options.key ?? "",
    workers: options.workers ?? defaultWorkerCount(),
    env: envEntries,
  });
}

function getSharedSessionState(
  options: BatchThanatosSessionOptions = {},
): SharedSessionState {
  if (!thanatosAvailable()) throw new Error("thanatos binary not found");

  const registry = getSessionRegistry();
  const key = sessionRegistryKey(options);
  const existing = registry.get(key);
  if (existing) {
    return existing;
  }

  const broker = resolveBrokerConfig(options);
  if (broker) {
    const state: SharedSessionState = {
      sessionPromise: Promise.resolve(
        new BrokerThanatosSession(broker.url, broker.token),
      ),
      tail: Promise.resolve(),
    };
    registry.set(key, state);
    return state;
  }

  ensureSignalListeners();

  const state: SharedSessionState = {
    sessionPromise: Promise.resolve().then(() => {
      const session = new DirectThanatosSession();
      session.start(options.workers ?? defaultWorkerCount(), options.env);
      return session;
    }),
    tail: Promise.resolve(),
  };

  state.sessionPromise.catch(() => {
    if (registry.get(key) === state) {
      registry.delete(key);
    }
  });

  registry.set(key, state);
  return state;
}

function onProcessSignal(): void {
  console.error(
    "[thanatos harness] process signal received, closing batch sessions",
  );
  void closeBatchThanatosSessions();
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
  options: BatchThanatosSessionOptions = {},
): Promise<ThanatosSession> {
  return getSharedSessionState(options).sessionPromise;
}

export async function withBatchThanatosSession<T>(
  callback: (session: ThanatosSession) => Promise<T>,
  options: BatchThanatosSessionOptions = {},
): Promise<T> {
  const state = getSharedSessionState(options);
  return await withTailLock(state, async () => {
    const session = await state.sessionPromise;
    if (options.resetBefore ?? true) {
      await session.reset();
    }
    try {
      return await callback(session);
    } finally {
      if (options.resetAfter ?? true) {
        await session.reset().catch(() => {});
      }
    }
  });
}

export async function closeBatchThanatosSessions(): Promise<void> {
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

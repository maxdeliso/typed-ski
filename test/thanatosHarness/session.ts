import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  BrokerThanatosSession,
  bytesToHex,
  closeThanatosSessions,
  defaultWorkerCount,
  DirectThanatosSession,
  getBatchBrokerEnvVarNames,
  getThanatosSession as getProductionThanatosSession,
  getDefaultTimeoutMs,
  hexToBytes,
  THANATOS_BATCH_BROKER_TOKEN_HEADER,
  thanatosAvailable,
  usingThanatosBatchBroker,
  withTailLock,
  withThanatosSession,
  type BrokerRequest,
  type BrokerResponse,
  type ThanatosBrokerConfig,
  type ThanatosSession,
  type ThanatosSessionOptions,
} from "../../lib/evaluator/thanatosEvaluator.ts";

const THANATOS_BATCH_BROKER_INTERNAL_ERROR = "Internal error";

export type BatchThanatosSessionOptions = ThanatosSessionOptions & {
  resetBefore?: boolean;
  resetAfter?: boolean;
};

export type StartedThanatosBatchBroker = {
  allowNet: string;
  env: Record<string, string>;
  close: () => Promise<void>;
};

export type BatchBrokerConfig = ThanatosBrokerConfig;
export type { ThanatosSession };

type TailLock = {
  tail: Promise<void>;
};

function debugLog(msg: string): void {
  if (process.env["THANATOS_DEBUG_LOGGING"] === "1") {
    console.error(msg);
  }
}

async function handleBrokerRequest(
  req: any,
  res: any,
  session: DirectThanatosSession,
  token: string,
  lock: TailLock,
): Promise<void> {
  const brokerReqId = randomUUID().slice(0, 8);
  debugLog(`[broker-server ${brokerReqId}] incoming ${req.method} ${req.url}`);
  if (req.method !== "POST") {
    res.writeHead(405).end("Method Not Allowed");
    return;
  }
  if (req.headers[THANATOS_BATCH_BROKER_TOKEN_HEADER.toLowerCase()] !== token) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  let aborted = false;

  let body = "";
  try {
    body = await new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: any) => {
        data += chunk;
      });
      req.on("end", () => {
        resolve(data);
      });
      req.on("error", reject);
      req.on("aborted", () => {
        debugLog(`[broker-server ${brokerReqId}] aborted by client`);
        aborted = true;
        reject(new Error("aborted"));
      });
    });
  } catch (error) {
    if (aborted) {
      return;
    }
    debugLog(`[broker-server ${brokerReqId}] body read error: ${error}`);
    return;
  }

  if (aborted) return;

  let reqId = "?";
  let op = "?";
  try {
    const payload = JSON.parse(body) as BrokerRequest;
    reqId = randomUUID().slice(0, 8);
    op = (payload as any).op;
    debugLog(`[broker] req=${reqId} op=${payload.op} starting`);

    const response = await withTailLock(
      lock,
      async (): Promise<BrokerResponse> => {
        const watchdogTimeout = getDefaultTimeoutMs();
        const watchdog = setTimeout(() => {
          debugLog(
            `[thanatos broker] WARNING: req=${reqId} op=${payload.op} has been running for ${watchdogTimeout / 1000}s`,
          );
        }, watchdogTimeout);
        watchdog.unref();

        try {
          debugLog(`[broker] req=${reqId} op=${payload.op} acquired lock`);
          if (aborted) throw new Error("Client disconnected");
          switch (payload.op) {
            case "signal":
              await session.signal(payload.signal);
              return { ok: true };
            case "rawRequest":
              return {
                ok: true,
                value: await session.rawRequest(payload.line),
              };
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
          }
        } finally {
          clearTimeout(watchdog);
        }
      },
    );
    debugLog(`[broker] req=${reqId} op=${payload.op} finished`);
    if (!aborted) {
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(response));
    }
  } catch (error) {
    debugLog(`[broker] req=${reqId} op=${op} FAILED: ${error}`);
    if (!aborted) {
      res.writeHead(500, { "content-type": "application/json" }).end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

export function startThanatosBatchBroker(
  options: BatchThanatosSessionOptions = {},
): Promise<StartedThanatosBatchBroker> {
  if (!thanatosAvailable(options.binPath)) {
    throw new Error("thanatos binary not found");
  }

  const session = new DirectThanatosSession(options);
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
      const envVarNames = getBatchBrokerEnvVarNames();

      resolve({
        allowNet: `127.0.0.1:${addr.port}`,
        env: {
          ...(options.env ?? {}),
          [envVarNames.url]: brokerUrl,
          [envVarNames.token]: token,
        },
        close: async () => {
          if ("closeAllConnections" in server) {
            (server as any).closeAllConnections();
          }
          await new Promise((r) => server.close(() => r(null)));
          await session.close().catch(() => {});
        },
      });
    });
  });
}

export function getThanatosSession(
  options: BatchThanatosSessionOptions = {},
): Promise<ThanatosSession> {
  return getProductionThanatosSession(options);
}

export async function withBatchThanatosSession<T>(
  callback: (session: ThanatosSession) => Promise<T>,
  options: BatchThanatosSessionOptions = {},
): Promise<T> {
  return await withThanatosSession(async (session) => {
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
  }, options);
}

export async function closeBatchThanatosSessions(): Promise<void> {
  await closeThanatosSessions();
}

export {
  BrokerThanatosSession,
  getBatchBrokerEnvVarNames,
  usingThanatosBatchBroker,
};

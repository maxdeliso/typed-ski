/**
 * Web Worker entry point for the parallel arena evaluator.
 *
 * @module
 */

import { getReleaseWasmBytes } from "./arenaWasmLoader.ts";
import type { ArenaWasmExports } from "./arenaEvaluator.ts";
import { isNode } from "../shared/platform.ts";

interface InitMessage {
  type: "init";
  memory: WebAssembly.Memory;
  workerId: number;
}

interface ConnectArenaMessage {
  type: "connectArena";
  arenaPointer: number;
}

let wasmExports: ArenaWasmExports | null = null;
let currentWorkerId = 0;

async function init(msg: InitMessage) {
  currentWorkerId = msg.workerId;
  const wasmBytes = await getReleaseWasmBytes();
  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, {
    env: {
      memory: msg.memory,
    },
  });
  wasmExports = instance.exports as unknown as ArenaWasmExports;

  postMessage({ type: "ready", workerId: msg.workerId });
}

function handleConnectArena(msg: ConnectArenaMessage) {
  if (!wasmExports || typeof wasmExports.connectArena !== "function") {
    postMessage({
      type: "connectArenaComplete",
      error: "connectArena export missing",
    });
    return;
  }
  try {
    const rc = wasmExports.connectArena(msg.arenaPointer);
    if (rc === 1) {
      postMessage({ type: "connectArenaComplete" });
      // Native workerLoop indexes per-worker control/QSBR state by worker id.
      // Passing the assigned id keeps concurrent requests isolated.
      wasmExports.workerLoop?.(currentWorkerId);
    } else {
      postMessage({
        type: "connectArenaComplete",
        error: `connectArena failed with code ${rc}`,
      });
    }
  } catch (err) {
    postMessage({
      type: "connectArenaComplete",
      error: `connectArena threw an error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

let nodeParentPort: any = null;

if (isNode) {
  const { workerData, parentPort } = await import("node:worker_threads");
  nodeParentPort = parentPort;
  if (workerData) {
    init({ type: "init", ...workerData }).catch((err) => {
      nodeParentPort?.postMessage({ type: "error", error: err.message });
    });
  }
  nodeParentPort?.on("message", (msg: any) => {
    if (msg.type === "connectArena") {
      handleConnectArena(msg);
    }
  });
} else {
  self.onmessage = (e) => {
    if (e.data.type === "init") {
      init(e.data).catch((err) => {
        self.postMessage({ type: "error", error: err.message });
      });
    } else if (e.data.type === "connectArena") {
      handleConnectArena(e.data as ConnectArenaMessage);
    }
  };
}

function postMessage(data: any) {
  if (isNode) {
    nodeParentPort?.postMessage(data);
  } else {
    (self as any).postMessage(data);
  }
}

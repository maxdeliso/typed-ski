/**
 * Web Worker entry point for the parallel arena evaluator.
 *
 * @module
 */

import { getEmbeddedReleaseWasm } from "./arenaWasm.embedded.ts";
import type { ArenaWasmExports } from "./arenaEvaluator.ts";
import { fromArenaWithExports, toArenaWithExports } from "./arenaEvaluator.ts";
import type { SKIExpression } from "../ski/expression.ts";
import type { ArenaNodeId } from "../shared/arena.ts";

interface InitMessage {
  type: "init";
  memory: WebAssembly.Memory;
  sab: SharedArrayBuffer;
  workerId: number;
}

interface ConnectArenaMessage {
  type: "connectArena";
  arenaPointer: number;
}

interface WorkMessage {
  type: "work";
  id: number;
  expr: SKIExpression;
  max?: number;
}

interface ResultMessage {
  type: "result";
  id: number;
  expr: SKIExpression;
  arenaNodeId: number; // Arena node ID for the result expression
}

let wasmExports: ArenaWasmExports | null = null;
let _workerId: number | null = null;

async function init(msg: InitMessage) {
  _workerId = msg.workerId;

  const wasmBytes = getEmbeddedReleaseWasm().slice();
  const module = await WebAssembly.compile(wasmBytes);
  const instance = await WebAssembly.instantiate(module, {
    env: { memory: msg.memory },
  });
  wasmExports = instance.exports as unknown as ArenaWasmExports;

  self.postMessage({ type: "ready", workerId: msg.workerId });
}

function handleConnectArena(msg: ConnectArenaMessage) {
  if (!wasmExports || typeof wasmExports.connectArena !== "function") {
    self.postMessage({
      type: "connectArenaComplete",
      error: "connectArena export missing",
    });
    return;
  }
  try {
    const rc = wasmExports.connectArena(msg.arenaPointer);
    if (rc === 1) {
      self.postMessage({ type: "connectArenaComplete" });
    } else {
      self.postMessage({
        type: "connectArenaComplete",
        error: `connectArena failed with code ${rc}`,
      });
    }
  } catch (err) {
    // Catch WASM traps (like unreachable) that might occur during connectArena
    self.postMessage({
      type: "connectArenaComplete",
      error: `connectArena threw an error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
  }
}

function toArena(root: SKIExpression, exports: ArenaWasmExports): ArenaNodeId {
  return toArenaWithExports(root, exports);
}

function fromArena(id: ArenaNodeId, exports: ArenaWasmExports): SKIExpression {
  return fromArenaWithExports(id, exports);
}

function handleWork(msg: WorkMessage) {
  if (!wasmExports) return;

  try {
    const arenaId = toArena(msg.expr, wasmExports);
    const max = msg.max ?? 0xffffffff;
    const resultId = wasmExports.reduce(arenaId, max);
    const result = fromArena(resultId, wasmExports);
    const resultMsg: ResultMessage = {
      type: "result",
      id: msg.id,
      expr: result,
      arenaNodeId: resultId, // Include the arena node ID
    };
    self.postMessage(resultMsg);
  } catch (err) {
    self.postMessage({
      type: "error",
      error: err instanceof Error ? err.message : String(err),
      workId: msg.id,
    });
  }
}

self.onmessage = (e) => {
  if (e.data.type === "init") {
    init(e.data).catch((err) => {
      self.postMessage({ type: "error", error: err.message });
    });
  } else if (e.data.type === "connectArena") {
    handleConnectArena(e.data as ConnectArenaMessage);
  } else if (e.data.type === "work") {
    handleWork(e.data as WorkMessage);
  }
};

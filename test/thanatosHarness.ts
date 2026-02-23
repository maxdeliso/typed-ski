/**
 * Test harness for running SKI reduction via the native thanatos binary.
 * Each call uses batch mode: spawn process, send all input, close stdin, read all output, then close process.
 */

import { existsSync } from "std/fs";
import { dirname, fromFileUrl, join } from "std/path";
import type { Evaluator } from "../lib/evaluator/evaluator.ts";
import type { SKIExpression } from "../lib/ski/expression.ts";

const __dirname = dirname(fromFileUrl(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

/** Path to the thanatos binary (built by make build-native). */
export const THANATOS_BIN = join(PROJECT_ROOT, "bin", "thanatos");

export function thanatosAvailable(): boolean {
  return existsSync(THANATOS_BIN);
}

/**
 * Evaluator that does not reduce; for decoding already-normal forms from thanatos stdout.
 */
export const passthroughEvaluator: Evaluator = {
  stepOnce: (expr: SKIExpression) => ({ altered: false, expr }),
  reduce: (expr: SKIExpression) => expr,
  reduceAsync: (expr: SKIExpression) => Promise.resolve(expr),
};

function defaultWorkerCount(): number {
  return typeof navigator !== "undefined" && navigator.hardwareConcurrency > 0
    ? navigator.hardwareConcurrency
    : 4;
}

/** Run thanatos in batch mode with the given input lines; returns one output line per input line. */
async function runThanatosWithInput(lines: string[]): Promise<string[]> {
  if (!thanatosAvailable()) {
    throw new Error("thanatos binary not found");
  }
  if (lines.length === 0) return [];

  const workers = defaultWorkerCount();
  const child = new Deno.Command(THANATOS_BIN, {
    args: [String(workers)],
    cwd: PROJECT_ROOT,
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();

  const writer = child.stdin.getWriter();
  const reader = child.stdout.getReader();

  try {
    const input = lines.join("\n") + "\n";
    await writer.write(new TextEncoder().encode(input));
    await writer.close();

    const decoder = new TextDecoder();
    const outLines: string[] = [];
    let buffer = new Uint8Array(0);
    while (true) {
      const newline = buffer.indexOf(0x0a);
      if (newline >= 0) {
        outLines.push(
          decoder.decode(buffer.subarray(0, newline)).replace(/\r$/, ""),
        );
        buffer = buffer.subarray(newline + 1);
        continue;
      }
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.length > 0) {
          outLines.push(decoder.decode(buffer).replace(/\r$/, ""));
        }
        break;
      }
      if (value && value.length > 0) {
        const merged = new Uint8Array(buffer.length + value.length);
        merged.set(buffer);
        merged.set(value, buffer.length);
        buffer = merged;
      }
    }
    await child.status;
    return outLines;
  } finally {
    try {
      reader.cancel();
    } catch (e) {
      console.error(e instanceof Error ? e.message : "failed to cancel reader");
    }
  }
}

/**
 * Run one expression through thanatos.
 */
export async function runThanatosOne(exprLine: string): Promise<string> {
  const out = await runThanatosWithInput([exprLine]);
  return out[0] ?? "";
}

/**
 * Run multiple expressions through thanatos.
 */
export async function runThanatosBatch(exprLines: string[]): Promise<string[]> {
  if (exprLines.length === 0) return [];
  return await runThanatosWithInput(exprLines);
}

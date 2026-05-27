/**
 * Verification seam for the self-hosted native front-half.
 *
 * Exercises the .trip lowering chain Core -> MiniCore -> ANF
 * (coreToMini.trip, miniCore.trip, anf.trip) by running the .trip
 * verifier `MiniVerify.verifyToAnfText` under the TypeScript MiniCore
 * evaluator and golden-snapshotting its ANF rendering.
 */

import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";
import { compilerTripModuleSourcePath } from "../../lib/compiler/bootstrapModules.ts";
import { compileMiniCoreModules } from "../../lib/minicore/fromTrip.ts";
import { evaluateMiniCore } from "../../lib/minicore/evaluator.ts";
import type { Value } from "../../lib/minicore/ast.ts";
import {
  buildMiniVerifyHarnessSource,
  MINI_VERIFY_MODULE_NAMES,
} from "./minicoreAnfHarness.ts";

const GOLDEN_FILE = join(
  workspaceRoot,
  "test",
  "compiler",
  "inputs",
  "minicoreAnf.golden.txt",
);

/** Decodes a Scott/ADT-encoded `List U8` MiniCore value to a byte array. */
function valueToBytes(value: Value): number[] {
  const bytes: number[] = [];
  let cur: Value = value;
  while (cur.kind === "con" && cur.fields.length === 2) {
    const head = cur.fields[0];
    const tail = cur.fields[1];
    if (head === undefined || tail === undefined || head.kind !== "lit") {
      throw new Error(`expected u8 list head, got ${JSON.stringify(head)}`);
    }
    const literal = head.value;
    if (literal.kind !== "u8") {
      throw new Error(`expected u8 list head, got ${JSON.stringify(head)}`);
    }
    bytes.push(literal.value);
    cur = tail;
  }
  if (cur.kind !== "con" || cur.fields.length !== 0) {
    throw new Error(`expected nil terminator, got ${JSON.stringify(cur)}`);
  }
  return bytes;
}

describe("MiniCore/ANF self-host verification", () => {
  it("lowers a corpus through the .trip Core->MiniCore->ANF chain", async () => {
    const modules: Array<{ name: string; source: string }> = await Promise.all(
      MINI_VERIFY_MODULE_NAMES.map(async (name) => ({
        name,
        source: await readFile(compilerTripModuleSourcePath(name), "utf8"),
      })),
    );
    modules.push({
      name: "Verify",
      source: buildMiniVerifyHarnessSource("list"),
    });

    const program = compileMiniCoreModules(modules, "Verify");
    const result = evaluateMiniCore(program);
    const actual = Buffer.from(valueToBytes(result.value)).toString("utf8");

    if (!existsSync(GOLDEN_FILE)) {
      await writeFile(GOLDEN_FILE, actual, "utf8");
      console.warn(`wrote new golden file: ${GOLDEN_FILE}`);
      return;
    }

    const expected = await readFile(GOLDEN_FILE, "utf8");
    assert.equal(actual, expected);
  });
});

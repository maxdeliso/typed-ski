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
import { compileMiniCoreModules } from "../../lib/minicore/fromTrip.ts";
import { evaluateMiniCore } from "../../lib/minicore/evaluator.ts";
import type { Value } from "../../lib/minicore/ast.ts";

const MODULE_FILES: ReadonlyArray<readonly [string, string]> = [
  ["Prelude", "lib/prelude.trip"],
  ["Nat", "lib/nat.trip"],
  ["Bin", "lib/bin.trip"],
  ["Avl", "lib/avl.trip"],
  ["Lexer", "lib/compiler/lexer.trip"],
  ["Parser", "lib/compiler/parser.trip"],
  ["Core", "lib/compiler/core.trip"],
  ["DataEnv", "lib/compiler/dataEnv.trip"],
  ["CoreToLower", "lib/compiler/coreToLower.trip"],
  ["Unparse", "lib/compiler/unparse.trip"],
  ["Lowering", "lib/compiler/lowering.trip"],
  ["Bridge", "lib/compiler/bridge.trip"],
  ["CoreToMini", "lib/compiler/coreToMini.trip"],
  ["MiniCore", "lib/compiler/miniCore.trip"],
  ["Anf", "lib/compiler/anf.trip"],
  ["MiniVerify", "lib/compiler/miniVerify.trip"],
];

const CORPUS: ReadonlyArray<readonly [string, string]> = [
  [
    "identity",
    `module Demo
export main
poly main = \\x : U8 => x
`,
  ],
  [
    "letBinding",
    `module Demo
export main
poly main = \\x : U8 => let y = x in y
`,
  ],
  [
    "nestedCall",
    `module Demo
export konst
export main
poly konst = \\x : U8 => \\y : U8 => x
poly main = \\z : U8 => konst (konst z z) z
`,
  ],
  [
    "adtMatch",
    `module Demo
export main
data Bit = O | I
poly flip = \\b : Bit => match b {
  | O => I
  | I => O
}
poly main = flip O
`,
  ],
];

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

/** Right-nested `append [U8]` over the given trip expressions. */
function tripAppend(parts: string[]): string {
  const [first, ...rest] = parts;
  if (first === undefined) {
    throw new Error("tripAppend requires at least one part");
  }
  const firstPart = first;
  if (rest.length === 0) {
    return firstPart;
  }
  return `append [U8] (${firstPart}) (${tripAppend(rest)})`;
}

function buildHarnessSource(): string {
  const parts: string[] = [];
  for (const [label, source] of CORPUS) {
    parts.push(JSON.stringify(`=== ${label} ===\n`));
    parts.push(`verifyToAnfText ${JSON.stringify(source)}`);
    parts.push(JSON.stringify("\n"));
  }
  return `module Verify
import Prelude List
import Prelude U8
import Prelude append
import MiniVerify verifyToAnfText

export main

poly main = ${tripAppend(parts)}
`;
}

describe("MiniCore/ANF self-host verification", () => {
  it("lowers a corpus through the .trip Core->MiniCore->ANF chain", async () => {
    const modules = await Promise.all(
      MODULE_FILES.map(async ([name, relPath]) => ({
        name,
        source: await readFile(join(workspaceRoot, relPath), "utf8"),
      })),
    );
    modules.push({ name: "Verify", source: buildHarnessSource() });

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

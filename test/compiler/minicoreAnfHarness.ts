/**
 * Shared corpus and harness-source builder for the MiniCore/ANF
 * verification seam exercised by both `minicoreAnf.test.ts` (host MiniCore
 * evaluator) and `llvm/bootstrapMiniVerify.test.ts` (stage-0 native exe).
 *
 * Both tests funnel the same fixtures through `MiniVerify.verifyToAnfText`
 * and compare the resulting bytes against `inputs/minicoreAnf.golden.txt`.
 */

import type { CompilerTripModuleName } from "../../lib/compiler/bootstrapModules.ts";

export const MINI_VERIFY_MODULE_NAMES: readonly CompilerTripModuleName[] = [
  "Prelude",
  "Nat",
  "Bin",
  "Avl",
  "Lexer",
  "Parser",
  "Core",
  "DataEnv",
  "Unparse",
  "Bridge",
  "CoreToMini",
  "MiniCore",
  "Anf",
  "MiniVerify",
];

export const MINI_VERIFY_CORPUS: ReadonlyArray<readonly [string, string]> = [
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

/** Right-nested `append [U8]` over the given trip expressions. */
function tripAppend(parts: string[]): string {
  const [first, ...rest] = parts;
  if (first === undefined) {
    throw new Error("tripAppend requires at least one part");
  }
  if (rest.length === 0) {
    return first;
  }
  return `append [U8] (${first}) (${tripAppend(rest)})`;
}

function corpusAppendExpression(): string {
  const parts: string[] = [];
  for (const [label, source] of MINI_VERIFY_CORPUS) {
    parts.push(JSON.stringify(`=== ${label} ===\n`));
    parts.push(`verifyToAnfText ${JSON.stringify(source)}`);
    parts.push(JSON.stringify("\n"));
  }
  return tripAppend(parts);
}

export type MiniVerifyHarnessWrap = "list" | "writeAll";

/**
 * Builds a `module Verify` entry source that runs `verifyToAnfText` on the
 * full corpus and assembles the concatenated output.
 *
 * - `wrap: "list"` makes `main : List U8` for the host MiniCore evaluator.
 * - `wrap: "writeAll"` streams bytes via `writeOne` so `main : U8` and the
 *   host LLVM emitter produces a runnable stdout-emitting binary.
 */
export function buildMiniVerifyHarnessSource(
  wrap: MiniVerifyHarnessWrap,
): string {
  const appendExpr = corpusAppendExpression();
  if (wrap === "list") {
    return `module Verify
import Prelude List
import Prelude U8
import Prelude append
import MiniVerify verifyToAnfText

export main

poly main = ${appendExpr}
`;
  }
  return `module Verify
import Prelude List
import Prelude U8
import Prelude append
import Prelude matchList
import Prelude writeOne
import MiniVerify verifyToAnfText

export main

poly rec writeAll = \\bytes : List U8 =>
  matchList [U8] [U8] bytes
    #u8(0)
    (\\h : U8 => \\t : List U8 => writeOne h [U8] (\\u : U8 => writeAll t))

poly main = writeAll (${appendExpr})
`;
}

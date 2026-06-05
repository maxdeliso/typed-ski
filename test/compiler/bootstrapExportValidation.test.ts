/**
 * Exercises the bootstrap (.trip) front-half export validation
 * (`ModuleEnv.buildModuleEnv` + `ModuleEnv.validateExports`) through the host
 * MiniCore evaluator (no clang, runs under bun).
 *
 * Regression for the "global flat export namespace" bug: the compile-gate
 * ambiguity check used to count export origins by symbol NAME across all
 * modules, so a bundle in which two modules each `export main` (which the whole
 * bootstrap corpus does) was rejected as AMBIGUOUS — blocking the compiler from
 * ever ingesting its own source. The check is now module-scoped: an export is
 * ambiguous only if the SAME module exports the SAME symbol more than once.
 *
 * A small `Verify` module builds tiny in-memory bundles from source text,
 * runs the real `buildModuleEnv` + `validateExports`, and renders the outcome.
 */

import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compilerTripModuleSourcePath } from "../../lib/compiler/bootstrapModules.ts";
import { compileMiniCoreModules } from "../../lib/minicore/fromTrip.ts";
import { evaluateMiniCore } from "../../lib/minicore/evaluator.ts";
import type { Value } from "../../lib/minicore/ast.ts";

const MODULE_NAMES = [
  "Prelude",
  "Nat",
  "Bin",
  "Lexer",
  "Parser",
  "BundleSummary",
  "ModuleEnv",
] as const;

const VERIFY_SOURCE = `module Verify

import Prelude List
import Prelude U8
import Prelude append
import Prelude Result
import Prelude Ok
import Prelude Err
import Prelude Bool
import Prelude nil
import Prelude cons
import BundleSummary ModuleRecord
import BundleSummary MkModuleRecord
import ModuleEnv ModuleEnv
import ModuleEnv MkModuleEnv
import ModuleEnv buildModuleEnv
import ModuleEnv validateExports

export main

poly nl = cons [U8] #u8(10) (nil [U8])

poly mkRec = \\name : List U8 => \\src : List U8 => MkModuleRecord name "" src

poly renderExports = \\mEnv : ModuleEnv =>
  do [List U8] {
    MkModuleEnv mods imps exps defs dataTypes ctors aliases opaques natives primitives = mEnv
    return
    match (validateExports exps defs ctors) [List U8] {
      | Err e => append [U8] "ERR:" e
      | Ok b => "OK"
    }
  }

poly checkBundle = \\mods : List ModuleRecord =>
  match (buildModuleEnv mods) [List U8] {
    | Err e => append [U8] "BUILDERR:" e
    | Ok mEnv => renderExports mEnv
  }

poly twoMains =
  checkBundle
    (cons [ModuleRecord] (mkRec "A" "module A\\nexport main\\npoly main : U8 = #u8(7)\\n")
    (cons [ModuleRecord] (mkRec "B" "module B\\nexport main\\npoly main : U8 = #u8(9)\\n")
    (nil [ModuleRecord])))

poly undefinedExport =
  checkBundle
    (cons [ModuleRecord] (mkRec "C" "module C\\nexport ghost\\npoly main : U8 = #u8(1)\\n")
    (nil [ModuleRecord]))

poly dupExport =
  checkBundle
    (cons [ModuleRecord] (mkRec "D" "module D\\nexport main\\nexport main\\npoly main : U8 = #u8(2)\\n")
    (nil [ModuleRecord]))

poly main =
  append [U8] twoMains
    (append [U8] nl
      (append [U8] undefinedExport
        (append [U8] nl dupExport)))
`;

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

describe("bootstrap front-half export validation", () => {
  it("accepts multiple modules each exporting `main`, still rejects undefined and same-module duplicate exports", async () => {
    const modules: Array<{ name: string; source: string }> = await Promise.all(
      MODULE_NAMES.map(async (name) => ({
        name,
        source: await readFile(compilerTripModuleSourcePath(name), "utf8"),
      })),
    );
    modules.push({ name: "Verify", source: VERIFY_SOURCE });

    const program = compileMiniCoreModules(modules, "Verify");
    const result = evaluateMiniCore(program);
    const text = Buffer.from(valueToBytes(result.value)).toString("utf8");
    const [twoMains, undefinedExport, dupExport] = text.split("\n");

    // The fix: two modules each exporting `main` is no longer ambiguous.
    assert.equal(twoMains, "OK");

    // Guard against over-loosening: a symbol exported but not defined in its
    // module is still rejected.
    assert.match(undefinedExport ?? "", /EXPORT_UNDEFINED/);
    assert.match(undefinedExport ?? "", /module C, export ghost/);

    // The ambiguity check is preserved in its correct, module-scoped form: a
    // single module exporting the same symbol twice is still AMBIGUOUS.
    assert.match(dupExport ?? "", /AMBIGUOUS/);
    assert.match(dupExport ?? "", /module D, export main/);
  });
});

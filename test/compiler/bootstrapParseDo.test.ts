/**
 * Exercises the bootstrap (.trip) parser's monadic `do { ... }` notation through
 * the host MiniCore evaluator (no clang).
 *
 * A small `Verify` module tokenizes `do`/`cond` snippets, runs the real bootstrap
 * `parseExpr`, and renders the resulting (type-erased) AST to a parenthesized
 * s-expression. `do` is sugar over `Result`-style ADTs and must desugar to nested
 * `match`/`let`/`if` exactly as the host parser does:
 *   - `name <- expr`        -> match expr { Err e => Err e | Ok name => rest }
 *   - `Ctor p... = expr`    -> match expr { Ctor p... => rest }
 *   - `name = expr`         -> let name = expr in rest
 *   - `assert cond else err`-> if cond (\u => rest) (\u => Err err)
 *   - `return val` / `expr` -> the final value
 *
 * The renderer prints E_App as `(f x)`, E_Lam as `(\n. b)`, E_Let as
 * `(let n = v in b)` and E_Match as `(match s { Ctor p => b | ... })`.
 */

import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { compilerTripModuleSourcePath } from "../../lib/compiler/bootstrapModules.ts";
import { compileMiniCoreModules } from "../../lib/minicore/fromTrip.ts";
import { evaluateMiniCore } from "../../lib/minicore/evaluator.ts";
import type { Value } from "../../lib/minicore/ast.ts";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";

const MODULE_NAMES = ["Prelude", "Lexer", "Parser"] as const;

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

describe("bootstrap parser do-notation", () => {
  it("desugars monadic do blocks to nested match/let/if via the .trip parser", async () => {
    const modules: Array<{ name: string; source: string }> = await Promise.all(
      MODULE_NAMES.map(async (name) => ({
        name,
        source: await readFile(compilerTripModuleSourcePath(name), "utf8"),
      })),
    );
    const verifySource = await readFile(
      join(workspaceRoot, "test", "compiler", "inputs", "Verify.trip"),
      "utf8",
    );
    modules.push({ name: "Verify", source: verifySource });

    const program = compileMiniCoreModules(modules, "Verify");
    const result = evaluateMiniCore(program);
    const text = Buffer.from(valueToBytes(result.value)).toString("utf8");
    const lines = text.split("\n").filter((line) => line.length > 0);

    const [
      bindReturn,
      twoBinds,
      destructure,
      letStep,
      assertGuard,
      combined,
      cond,
      corpusTwoBind,
    ] = lines;

    // `name <- expr` is a monadic bind: short-circuits on Err, binds Ok.
    assert.equal(bindReturn, "(match foo { Err e => (Err e) | Ok x => x })");
    assert.equal(
      twoBinds,
      "(match foo { Err e => (Err e) | Ok x => (match bar { Err e => (Err e) | Ok y => y }) })",
    );

    // `Ctor p... = expr` is a single-arm destructuring match.
    assert.equal(destructure, "(match foo { MkLine a b => a })");

    // `name = expr` is a plain let.
    assert.equal(letStep, "(let v = foo in v)");

    // `assert cond else err` is an if-guard returning Err on failure.
    assert.equal(assertGuard, "(((if c) (\\u. ok)) (\\u. (Err e)))");

    // All four step kinds compose into the expected nesting.
    assert.equal(
      combined,
      "(match foo { Err e => (Err e) | Ok x => (match x { MkLine magic => (((if c) (\\u. (Ok magic))) (\\u. (Err bad))) }) })",
    );

    // cond (lazy if-chains) still desugars correctly alongside do.
    assert.equal(cond, "(((if c1) (\\u. a)) (\\u. b))");

    // A corpus-shaped block: parenthesised bind expressions + type-app return.
    assert.equal(
      corpusTwoBind,
      "(match (emitOne h) { Err e => (Err e) | Ok headText => (match (emitRest t) { Err e => (Err e) | Ok tailText => (Ok ((append headText) tailText)) }) })",
    );
  });
});

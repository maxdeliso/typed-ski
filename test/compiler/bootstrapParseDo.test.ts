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
import { compilerTripModuleSourcePath } from "../../lib/compiler/bootstrapModules.ts";
import { compileMiniCoreModules } from "../../lib/minicore/fromTrip.ts";
import { evaluateMiniCore } from "../../lib/minicore/evaluator.ts";
import type { Value } from "../../lib/minicore/ast.ts";

const MODULE_NAMES = ["Prelude", "Lexer", "Parser"] as const;

const VERIFY_SOURCE = `module Verify

import Prelude List
import Prelude U8
import Prelude append
import Prelude fst
import Prelude snd
import Prelude Ok
import Prelude Err
import Prelude nil
import Prelude cons
import Prelude matchList
import Prelude Pair
import Lexer tokenize
import Lexer Token
import Parser parseExpr
import Parser Expr
import Parser E_Var
import Parser E_App
import Parser E_Lam
import Parser E_Let
import Parser E_Nat
import Parser E_Match
import Parser Pattern
import Parser P_Ctor
import Parser fstExprToken

export main

poly nl = cons [U8] #u8(10) (nil [U8])

poly rec renderParams = \\ps : List (List U8) =>
  matchList [List U8] [List U8] ps
    ""
    (\\h : List U8 => \\t : List (List U8) =>
      append [U8] " " (append [U8] h (renderParams t)))

poly patToSexp = \\p : Pattern =>
  match p [List U8] {
    | P_Ctor name params => append [U8] name (renderParams params)
  }

poly rec armsToSexp =
  \\render : (Expr -> List U8) =>
    \\arms : List (Pair Pattern Expr) =>
      matchList [Pair Pattern Expr] [List U8] arms
        ""
        (\\h : Pair Pattern Expr => \\t : List (Pair Pattern Expr) =>
          let pat = fst [Pattern] [Expr] h in
          let body = snd [Pattern] [Expr] h in
          let armStr = append [U8] (patToSexp pat) (append [U8] " => " (render body)) in
          matchList [Pair Pattern Expr] [List U8] t
            armStr
            (\\h2 : Pair Pattern Expr => \\t2 : List (Pair Pattern Expr) =>
              append [U8] armStr (append [U8] " | " (armsToSexp render t))))

poly rec exprToSexp = \\e : Expr =>
  match e [List U8] {
    | E_Var n => n
    | E_App f x =>
        append [U8] "("
          (append [U8] (exprToSexp f)
            (append [U8] " "
              (append [U8] (exprToSexp x) ")")))
    | E_Lam n b =>
        append [U8] "(\\\\"
          (append [U8] n
            (append [U8] ". "
              (append [U8] (exprToSexp b) ")")))
    | E_Let n v b =>
        append [U8] "(let "
          (append [U8] n
            (append [U8] " = "
              (append [U8] (exprToSexp v)
                (append [U8] " in "
                  (append [U8] (exprToSexp b) ")")))))
    | E_Nat d => append [U8] "#" d
    | E_Match s arms =>
        append [U8] "(match "
          (append [U8] (exprToSexp s)
            (append [U8] " { "
              (append [U8] (armsToSexp exprToSexp arms) " })")))
  }

poly renderExprSrc = \\src : List U8 =>
  match (tokenize src) [List U8] {
    | Err e => "LEXERR"
    | Ok toks =>
        match (parseExpr toks) [List U8] {
          | Err e => "PARSEERR"
          | Ok res => exprToSexp (fstExprToken res)
        }
  }

poly rec joinLines = \\xs : List (List U8) =>
  matchList [List U8] [List U8] xs
    (nil [U8])
    (\\h : List U8 => \\t : List (List U8) =>
      append [U8] h (append [U8] nl (joinLines t)))

poly main =
  joinLines
    (cons [List U8] (renderExprSrc "do [Result U8 U8] { x <- foo return x }")
    (cons [List U8] (renderExprSrc "do [Result U8 U8] { x <- foo y <- bar return y }")
    (cons [List U8] (renderExprSrc "do [Result U8 U8] { MkLine a b = foo return a }")
    (cons [List U8] (renderExprSrc "do [Result U8 U8] { v = foo return v }")
    (cons [List U8] (renderExprSrc "do [Result U8 U8] { assert c else e return ok }")
    (cons [List U8] (renderExprSrc "do [Result U8 U8] { x <- foo MkLine magic = x assert c else bad return Ok magic }")
    (cons [List U8] (renderExprSrc "cond [U8] {| c1 => a | otherwise => b }")
    (cons [List U8] (renderExprSrc "do [Result (List U8) (List U8)] { headText <- (emitOne h) tailText <- (emitRest t) return Ok [List U8] [List U8] (append [U8] headText tailText) }")
    (nil [List U8])))))))))
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

describe("bootstrap parser do-notation", () => {
  it("desugars monadic do blocks to nested match/let/if via the .trip parser", async () => {
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

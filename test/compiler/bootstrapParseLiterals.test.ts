/**
 * Exercises the bootstrap (.trip) parser's `{}` list / pair-term literals and
 * `()` tuple-type sugar through the host MiniCore evaluator (no clang).
 *
 * A small `Verify` module tokenizes source snippets, runs the real bootstrap
 * `parseExpr` / `parseType`, and renders the resulting (type-erased) AST to a
 * parenthesized s-expression. The sugar must desugar to exactly the same AST
 * as the hand-written `cons`/`MkPair`/`Pair` forms.
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
import Prelude Ok
import Prelude Err
import Prelude nil
import Prelude cons
import Prelude matchList
import Lexer tokenize
import Lexer Token
import Parser parseExpr
import Parser parseType
import Parser Expr
import Parser E_Var
import Parser E_App
import Parser E_Lam
import Parser E_Let
import Parser E_Nat
import Parser E_Match
import Parser Type
import Parser Ty_Var
import Parser Ty_App
import Parser Ty_Arrow
import Parser Ty_Forall
import Parser fstExprToken

export main

poly nl = cons [U8] #u8(10) (nil [U8])

poly rec exprToSexp = \\e : Expr =>
  match e [List U8] {
    | E_Var n => n
    | E_App f x =>
        append [U8] "("
          (append [U8] (exprToSexp f)
            (append [U8] " "
              (append [U8] (exprToSexp x) ")")))
    | E_Lam n b => "<lam>"
    | E_Let n v b => "<let>"
    | E_Nat d => "<nat>"
    | E_Match s arms => "<match>"
  }

poly rec typeToSexp = \\t : Type =>
  match t [List U8] {
    | Ty_Var n => n
    | Ty_App f x =>
        append [U8] "("
          (append [U8] (typeToSexp f)
            (append [U8] " "
              (append [U8] (typeToSexp x) ")")))
    | Ty_Arrow a b =>
        append [U8] "(-> "
          (append [U8] (typeToSexp a)
            (append [U8] " "
              (append [U8] (typeToSexp b) ")")))
    | Ty_Forall n b => "<forall>"
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

poly renderTypeSrc = \\src : List U8 =>
  match (tokenize src) [List U8] {
    | Err e => "LEXERR"
    | Ok toks =>
        match (parseType toks) [List U8] {
          | Err e => "PARSEERR"
          | Ok res => typeToSexp (fst [Type] [List Token] res)
        }
  }

poly rec joinLines = \\xs : List (List U8) =>
  matchList [List U8] [List U8] xs
    (nil [U8])
    (\\h : List U8 => \\t : List (List U8) =>
      append [U8] h (append [U8] nl (joinLines t)))

poly main =
  joinLines
    (cons [List U8] (renderExprSrc "{U8 | a b}")
    (cons [List U8] (renderExprSrc "cons a (cons b nil)")
    (cons [List U8] (renderExprSrc "{U8, U8 | a, b}")
    (cons [List U8] (renderExprSrc "MkPair a b")
    (cons [List U8] (renderExprSrc "{U8 | }")
    (cons [List U8] (renderExprSrc "{U8 | (f x) y}")
    (cons [List U8] (renderTypeSrc "(U8, U8)")
    (cons [List U8] (renderTypeSrc "Pair U8 U8")
    (cons [List U8] (renderTypeSrc "(U8)")
    (cons [List U8] (renderTypeSrc "(U8 -> U8)")
    (nil [List U8])))))))))))
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

describe("bootstrap parser list/tuple literals", () => {
  it("desugars {} list / pair literals and () tuple types via the .trip parser", async () => {
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
      listLiteral,
      listDesugared,
      pairLiteral,
      pairDesugared,
      emptyList,
      nestedList,
      tupleType,
      pairType,
      parenType,
      arrowType,
    ] = lines;

    // List literal `{T | e1 e2}` == `cons e1 (cons e2 nil)`.
    assert.equal(listLiteral, "((cons a) ((cons b) nil))");
    assert.equal(listLiteral, listDesugared);

    // Pair-term literal `{T1, T2 | a, b}` == `MkPair a b`.
    assert.equal(pairLiteral, "((MkPair a) b)");
    assert.equal(pairLiteral, pairDesugared);

    // Empty list desugars to bare `nil`.
    assert.equal(emptyList, "nil");

    // List elements are atoms; parentheses group sub-applications.
    assert.equal(nestedList, "((cons (f x)) ((cons y) nil))");

    // Tuple type `(T1, T2)` == `Pair T1 T2`.
    assert.equal(tupleType, "((Pair U8) U8)");
    assert.equal(tupleType, pairType);

    // A single parenthesized type is unwrapped; arrows inside parens survive.
    assert.equal(parenType, "U8");
    assert.equal(arrowType, "(-> U8 U8)");
  });
});

/**
 * Comment-handling parity between the two TripLang front-ends.
 *
 * Haskell-style comments (`-- ...` and nesting `{- ... -}`) must be handled
 * identically by:
 *   1. the self-hosted bootstrap lexer (`bootstrap/src/lexer.trip`), exercised
 *      here end-to-end through the host MiniCore evaluator (no clang), and
 *   2. the TypeScript reference parser (`lib/parser`).
 *
 * Each case is a commented snippet that must reduce to the same thing as its
 * bare twin. The bootstrap side proves this by tokenizing + parsing the snippet
 * with the real `Lexer`/`Parser` and rendering the resulting AST to an
 * s-expression; the reference side proves it by parsing both forms and
 * comparing ASTs. The unterminated-block-comment case must be rejected by
 * both.
 */

import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compilerTripModuleSourcePath } from "../../lib/compiler/bootstrapModules.ts";
import { compileMiniCoreModules } from "../../lib/minicore/fromTrip.ts";
import { evaluateMiniCore } from "../../lib/minicore/evaluator.ts";
import type { Value } from "../../lib/minicore/ast.ts";
import { parseSystemF } from "../../lib/parser/systemFTerm.ts";

const MODULE_NAMES = ["Prelude", "Lexer", "Parser"] as const;

/** Snippets whose comments must vanish, leaving `cons a b`. */
const VALID_CASES: ReadonlyArray<{ name: string; commented: string }> = [
  { name: "block comment between args", commented: "cons a {- mid -} b" },
  { name: "leading block comment", commented: "{- lead -} cons a b" },
  { name: "nested block comment", commented: "cons {- a {- n -} z -} a b" },
  { name: "trailing line comment to EOF", commented: "cons a b -- bye" },
  { name: "line comment ended by newline", commented: "cons a -- mid\n b" },
  { name: "block comment abutting tokens", commented: "cons{- x -}a b" },
];

const BARE = "cons a b";
const BARE_SEXP = "((cons a) b)";

/** Snippets both front-ends must reject. */
const ERR_CASES: ReadonlyArray<{ name: string; commented: string }> = [
  { name: "unterminated block comment", commented: "cons a {- oops" },
];

/** Encodes a JS string as a TripLang string literal (escaping for the lexer). */
const toTripStringLiteral = (s: string): string =>
  '"' +
  s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"') +
  '"';

/** Right-nested `cons`/`nil` list of `renderExprSrc <lit>` applications. */
const buildRenderList = (snippets: readonly string[]): string => {
  let expr = "(nil [List U8])";
  for (let i = snippets.length - 1; i >= 0; i--) {
    const lit = toTripStringLiteral(snippets[i]!);
    expr = `(cons [List U8] (renderExprSrc ${lit}) ${expr})`;
  }
  return expr;
};

// Output order: each VALID commented snippet, then the bare baseline once per
// VALID case, then each ERR commented snippet.
const RENDER_SNIPPETS: string[] = [
  ...VALID_CASES.map((c) => c.commented),
  ...VALID_CASES.map(() => BARE),
  ...ERR_CASES.map((c) => c.commented),
];

const VERIFY_SOURCE = `module Verify

import Prelude List
import Prelude U8
import Prelude append
import Prelude Ok
import Prelude Err
import Prelude nil
import Prelude cons
import Prelude matchList
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
  joinLines ${buildRenderList(RENDER_SNIPPETS)}
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

describe("comment handling parity (bootstrap lexer vs reference parser)", () => {
  it("the bootstrap lexer treats comments as whitespace (host MiniCore)", async () => {
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

    const n = VALID_CASES.length;
    const commentedLines = lines.slice(0, n);
    const bareLines = lines.slice(n, 2 * n);
    const errLines = lines.slice(2 * n, 2 * n + ERR_CASES.length);

    // Every bare baseline parses to the expected s-expression.
    for (const [i, line] of bareLines.entries()) {
      assert.equal(line, BARE_SEXP, `bare baseline ${i} should parse cleanly`);
    }

    // Every commented snippet collapses to exactly the bare result.
    VALID_CASES.forEach((c, i) => {
      assert.equal(
        commentedLines[i],
        BARE_SEXP,
        `${c.name}: "${c.commented}" should tokenize to ${BARE}`,
      );
    });

    // The unterminated block comment is a lex error, not silently consumed.
    ERR_CASES.forEach((c, i) => {
      assert.equal(errLines[i], "LEXERR", `${c.name}: expected LEXERR`);
    });
  });

  it("the reference parser treats the same comments as whitespace", () => {
    const [, bareTerm] = parseSystemF(BARE);

    for (const { name, commented } of VALID_CASES) {
      const [, commentedTerm] = parseSystemF(commented);
      assert.deepStrictEqual(
        commentedTerm,
        bareTerm,
        `${name}: "${commented}" should parse the same as ${BARE}`,
      );
    }

    for (const { name, commented } of ERR_CASES) {
      assert.throws(
        () => parseSystemF(commented),
        `${name}: reference parser should reject "${commented}"`,
      );
    }
  });
});

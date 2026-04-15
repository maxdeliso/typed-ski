import { describe, it } from "../../util/test_shim.ts";
/**
 * Bottom-up parse and elaboration test: single character literals and
 * double-quote string literals must be elaborated (in System F and through
 * to typed lambda) into correct List U8 forms — i.e. cons [U8] (#u8(n)) … (nil [U8]),
 * not List Bin or a bare U8 variable.
 *
 * Parse steps assert that the System F parser produces List U8 directly.
 * Elaboration steps run parse → index → elaborate (no resolve/typecheck) and assert
 * the elaborated term still has List U8 form, so we don't require Prelude in scope.
 * Once the parser produces List U8, full compile() with Prelude will also preserve it.
 */
import { strict as assert } from "node:assert";
import { parseSystemF } from "../../../lib/parser/systemFTerm.ts";
import type { SystemFTerm } from "../../../lib/terms/systemF.ts";
import { parseTripLang } from "../../../lib/parser/tripLang.ts";
import { expandDataDefinitions } from "../../../lib/meta/frontend/data.ts";
import { indexSymbols } from "../../../lib/meta/frontend/symbolTable.ts";
import { elaborateTerms } from "../../../lib/meta/frontend/elaboration.ts";

const U8_VAR_PREFIX = "__trip_u8_";

function parseU8CodeFromVar(name: string): number | null {
  if (!name.startsWith(U8_VAR_PREFIX)) return null;
  const code = Number(name.slice(U8_VAR_PREFIX.length));
  if (Number.isNaN(code) || code < 0 || code > 255) return null;
  return code;
}

/**
 * Returns the list of byte values if `term` is a List U8 (cons [U8] … nil [U8]);
 * returns null otherwise. Also returns null if the list uses Bin instead of U8.
 */
function extractListU8Bytes(term: SystemFTerm): number[] | null {
  const result: number[] = [];
  let current: SystemFTerm = term;

  for (;;) {
    if (current.kind === "systemF-type-app") {
      if (current.term.kind !== "systemF-var" || current.term.name !== "nil") {
        return null;
      }
      if (current.typeArg.kind !== "type-var") return null;
      if (current.typeArg.typeName !== "U8") return null;
      return result;
    }
    if (current.kind !== "non-terminal") return null;
    const consApp = current.lft;
    const tail = current.rgt;
    if (consApp.kind !== "non-terminal") return null;
    const consTypeApp = consApp.lft;
    const head = consApp.rgt;
    if (consTypeApp.kind !== "systemF-type-app") return null;
    if (
      consTypeApp.term.kind !== "systemF-var" ||
      consTypeApp.term.name !== "cons"
    ) {
      return null;
    }
    if (
      consTypeApp.typeArg.kind !== "type-var" ||
      consTypeApp.typeArg.typeName !== "U8"
    ) {
      return null;
    }
    if (head.kind !== "systemF-var") return null;
    const code = parseU8CodeFromVar(head.name);
    if (code === null) return null;
    result.push(code);
    current = tail;
  }
}

function assertListU8(
  term: SystemFTerm,
  expectedBytes: number[],
  msg?: string,
) {
  const actual = extractListU8Bytes(term);
  assert.notEqual(
    actual,
    null,
    msg ?? "expected term to be List U8 (cons [U8] … nil [U8])",
  );
  assert.deepEqual(actual, expectedBytes, msg ?? "List U8 byte content");
}

function assertU8(term: SystemFTerm, expectedCode: number, msg?: string) {
  if (term.kind !== "systemF-var") {
    assert.fail(msg ?? `expected bare U8 literal var, got ${term.kind}`);
  }
  const code = parseU8CodeFromVar(term.name);
  assert.strictEqual(
    code,
    expectedCode,
    msg ?? `expected U8 literal ${expectedCode}, got ${code}`,
  );
}

describe("Character and string literals → U8 / List U8 (parse + elaboration)", () => {
  it("parse: single character literal has U8 form", () => {
    const [, ast] = parseSystemF("'a'");
    assertU8(ast, 97);
  });

  it("parse: string literal has List U8 form", () => {
    const [, ast] = parseSystemF('"ab"');
    assertListU8(ast, [97, 98]);
  });

  it("parse: empty string literal has List U8 form", () => {
    const [, ast] = parseSystemF('""');
    assertListU8(ast, []);
  });

  it("elaboration: program with character literal elaborates to U8", () => {
    const src = "module Test\npoly main = 'a'";
    const parsed = expandDataDefinitions(parseTripLang(src));
    const symbols = indexSymbols(parsed);
    const elaborated = elaborateTerms(parsed, symbols);
    const mainPoly = elaborated.terms.find(
      (t) => t.kind === "poly" && t.name === "main",
    );
    assert.ok(mainPoly && mainPoly.kind === "poly");
    assertU8(mainPoly.term, 97);
  });

  it("elaboration: program with string literal elaborates to List U8", () => {
    const src = 'module Test\npoly main = "ab"';
    const parsed = expandDataDefinitions(parseTripLang(src));
    const symbols = indexSymbols(parsed);
    const elaborated = elaborateTerms(parsed, symbols);
    const mainPoly = elaborated.terms.find(
      (t) => t.kind === "poly" && t.name === "main",
    );
    assert.ok(mainPoly && mainPoly.kind === "poly");
    assertListU8(mainPoly.term, [97, 98]);
  });

  it("elaboration: program with empty string literal elaborates to List U8", () => {
    const src = 'module Test\npoly main = ""';
    const parsed = expandDataDefinitions(parseTripLang(src));
    const symbols = indexSymbols(parsed);
    const elaborated = elaborateTerms(parsed, symbols);
    const mainPoly = elaborated.terms.find(
      (t) => t.kind === "poly" && t.name === "main",
    );
    assert.ok(mainPoly && mainPoly.kind === "poly");
    assertListU8(mainPoly.term, []);
  });
});

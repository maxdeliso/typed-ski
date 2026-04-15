import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { parseTripLang } from "../../lib/parser/tripLang.ts";
import { fileURLToPath } from "node:url";
import {
  createSystemFApplication,
  mkSystemFAbs,
  mkSystemFTAbs,
  mkSystemFVar,
} from "../../lib/terms/systemF.ts";
import type { SystemFTerm } from "../../lib/terms/systemF.ts";
import { arrow, mkTypeVariable, typeApp } from "../../lib/types/types.ts";
import { apply } from "../../lib/ski/expression.ts";
import { I, K, S } from "../../lib/ski/terminal.ts";
import { loadInput } from "../util/fileLoader.ts";
import { requiredAt } from "../util/required.ts";
import { loadTripSourceFileSync } from "../../lib/tripSourceLoader.ts";
import { unparseSystemFType } from "../../lib/parser/systemFType.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const expectSystemFApp = (t: SystemFTerm) => {
  assert.strictEqual(t.kind, "non-terminal");
  return t as Extract<SystemFTerm, { kind: "non-terminal" }>;
};

const expectSystemFTypeApp = (t: SystemFTerm) => {
  assert.strictEqual(t.kind, "systemF-type-app");
  return t as Extract<SystemFTerm, { kind: "systemF-type-app" }>;
};

const expectSystemFVar = (t: SystemFTerm) => {
  assert.strictEqual(t.kind, "systemF-var");
  return t as Extract<SystemFTerm, { kind: "systemF-var" }>;
};

describe("parseTripLang", () => {
  it("parses polymorphic definitions", () => {
    const input = loadInput("polyId.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;

    assert.deepStrictEqual(moduleDecl, {
      kind: "module",
      name: "PolyId",
    });
    assert.deepStrictEqual(term, {
      kind: "poly",
      name: "id",
      type: undefined,
      term: mkSystemFTAbs(
        "a",
        mkSystemFAbs(
          "x",
          { kind: "type-var", typeName: "a" },
          mkSystemFVar("x"),
        ),
      ),
    });
  });

  it("parses recursive polymorphic definitions", () => {
    const input = loadInput("polyRec.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;

    assert.deepStrictEqual(moduleDecl, {
      kind: "module",
      name: "PolyRec",
    });
    assert.deepStrictEqual(term, {
      kind: "poly",
      name: "fact",
      rec: true,
      type: undefined,
      term: mkSystemFAbs(
        "n",
        { kind: "type-var", typeName: "Nat" },
        createSystemFApplication(mkSystemFVar("fact"), mkSystemFVar("n")),
      ),
    });
  });

  it("parses poly definitions with explicit types", () => {
    const input = loadInput("typedInc.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;

    assert.deepStrictEqual(moduleDecl, {
      kind: "module",
      name: "TypedInc",
    });
    assert.deepStrictEqual(term, {
      kind: "poly",
      name: "inc",
      type: arrow(
        { kind: "type-var", typeName: "Int" },
        { kind: "type-var", typeName: "Int" },
      ),
      term: mkSystemFAbs(
        "x",
        { kind: "type-var", typeName: "Int" },
        createSystemFApplication(
          createSystemFApplication(mkSystemFVar("plus"), mkSystemFVar("x")),
          mkSystemFVar("__trip_u8_1"),
        ),
      ),
    });
  });

  it("parses complex combinator definitions", () => {
    const input = loadInput("combinatorY.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;

    assert.deepStrictEqual(moduleDecl, {
      kind: "module",
      name: "CombinatorY",
    });
    assert.deepStrictEqual(term, {
      kind: "combinator",
      name: "Y",
      term: apply(
        apply(S, apply(K, apply(apply(S, I), I))),
        apply(
          apply(S, apply(apply(S, apply(K, S)), K)),
          apply(K, apply(apply(S, I), I)),
        ),
      ),
    });
  });

  it("parses type definitions correctly", () => {
    const input = loadInput("typeNat.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;

    const typeVar = (name: string) => ({
      kind: "type-var" as const,
      typeName: name,
    });
    const X = typeVar("X");

    assert.deepStrictEqual(moduleDecl, {
      kind: "module",
      name: "TypeNat",
    });
    assert.deepStrictEqual(term, {
      kind: "type",
      name: "Nat",
      type: {
        kind: "forall",
        typeVar: "X",
        body: arrow(arrow(X, X), arrow(X, X)),
      },
    });
  });

  it("parses data definitions", () => {
    const input = loadInput("dataMaybe.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;

    assert.deepStrictEqual(moduleDecl, {
      kind: "module",
      name: "DataMaybe",
    });
    assert.deepStrictEqual(term, {
      kind: "data",
      name: "Maybe",
      typeParams: ["A"],
      constructors: [
        { name: "Nothing", fields: [] },
        {
          name: "Just",
          fields: [{ kind: "type-var", typeName: "A" }],
        },
      ],
    });
  });

  it("parses data definitions with leading pipe and type-application field types", // "T_Keyword (List Nat)" parses; (3) allow type applications like (List Nat) // constructor (data T = \n  | C1); (2) skip whitespace before field types so // Parser must: (1) accept optional leading | and whitespace before the first
  // in field types, with space between type and argument.
  () => {
    const input = `module Lexer
data Token =
  | T_LParen
  | T_Keyword (List Nat)
  | T_EOF`;
    const [moduleDecl, term] = parseTripLang(input).terms;

    assert.deepStrictEqual(moduleDecl, {
      kind: "module",
      name: "Lexer",
    });
    assert.deepStrictEqual(term, {
      kind: "data",
      name: "Token",
      typeParams: [],
      constructors: [
        { name: "T_LParen", fields: [] },
        {
          name: "T_Keyword",
          fields: [typeApp(mkTypeVariable("List"), mkTypeVariable("Nat"))],
        },
        { name: "T_EOF", fields: [] },
      ],
    });
  });

  it("parses lib/compiler/lexer.trip Token ADT", () => {
    const lexerPath = join(
      __dirname,
      "..",
      "..",
      "lib",
      "compiler",
      "lexer.trip",
    );
    const input = loadTripSourceFileSync(lexerPath).trim();
    const program = parseTripLang(input);

    // Lightweight "whole file" sanity checks (beyond just the Token ADT)
    assert.deepStrictEqual(program.kind, "program");
    assert.deepStrictEqual(program.terms[0], { kind: "module", name: "Lexer" });
    assert.ok(
      program.terms.some((t) => t.kind === "export" && t.name === "Token"),
      "expected lexer.trip to export Token",
    );
    assert.ok(
      program.terms.some((t) => t.kind === "poly" && t.name === "tokenize"),
      "expected lexer.trip to define poly tokenize",
    );

    // Assert that every top-level TripLang definition in lexer.trip
    // has a corresponding entry in the parsed program.
    //
    // NOTE: This list is intentionally hardcoded (no regex parsing) so that
    // changes to lexer.trip require an explicit update here.
    const expectedImports = [
      { name: "Prelude", ref: "Bool" },
      { name: "Prelude", ref: "List" },
      { name: "Prelude", ref: "nil" },
      { name: "Prelude", ref: "cons" },
      { name: "Prelude", ref: "matchList" },
      { name: "Prelude", ref: "tail" },
      { name: "Prelude", ref: "if" },
      { name: "Prelude", ref: "and" },
      { name: "Prelude", ref: "or" },
      { name: "Prelude", ref: "true" },
      { name: "Prelude", ref: "false" },
      { name: "Prelude", ref: "Result" },
      { name: "Prelude", ref: "Err" },
      { name: "Prelude", ref: "Ok" },
      { name: "Prelude", ref: "ParseError" },
      { name: "Prelude", ref: "MkParseError" },
      { name: "Prelude", ref: "Maybe" },
      { name: "Prelude", ref: "Some" },
      { name: "Prelude", ref: "None" },
      { name: "Prelude", ref: "Pair" },
      { name: "Prelude", ref: "MkPair" },
      { name: "Prelude", ref: "fst" },
      { name: "Prelude", ref: "snd" },
      { name: "Prelude", ref: "foldl" },
      { name: "Prelude", ref: "append" },
      { name: "Prelude", ref: "reverse" },
      { name: "Prelude", ref: "U8" },
      { name: "Prelude", ref: "eqU8" },
    ] as const;

    const expectedExports = [
      "Token",
      "T_LParen",
      "T_RParen",
      "T_LBrace",
      "T_RBrace",
      "T_LBracket",
      "T_RBracket",
      "T_Backslash",
      "T_Arrow",
      "T_FatArrow",
      "T_Eq",
      "T_Colon",
      "T_Hash",
      "T_Pipe",
      "T_Dot",
      "T_Comma",
      "T_KwPoly",
      "T_KwRec",
      "T_KwLet",
      "T_KwIn",
      "T_KwMatch",
      "T_KwModule",
      "T_KwImport",
      "T_KwExport",
      "T_KwCombinator",
      "T_KwType",
      "T_KwData",
      "T_Ident",
      "T_Nat",
      "T_EOF",
      "tokenize",
      "kwPoly",
      "isKeywordPoly",
      "keywordTokenFromWord",
      "eqListU8",
      "mapResult",
    ] as const;

    const expectedData = ["Token"] as const;

    // Lexer imports reverse from Prelude; only locally defined polys listed
    const expectedPoly = ["tokenizeAcc", "tokenize"] as const;

    for (const { name, ref } of expectedImports) {
      assert.ok(
        program.terms.some(
          (t) => t.kind === "import" && t.name === name && t.ref === ref,
        ),
        `expected import ${name} ${ref}`,
      );
    }

    for (const name of expectedExports) {
      assert.ok(
        program.terms.some((t) => t.kind === "export" && t.name === name),
        `expected export ${name}`,
      );
    }

    for (const name of expectedData) {
      assert.ok(
        program.terms.some((t) => t.kind === "data" && t.name === name),
        `expected data ${name} = ...`,
      );
    }

    for (const name of expectedPoly) {
      assert.ok(
        program.terms.some((t) => t.kind === "poly" && t.name === name),
        `expected poly ${name} = ...`,
      );
    }

    const tokenData = program.terms.find(
      (term): term is typeof term & { kind: "data"; name: string } =>
        term.kind === "data" && term.name === "Token",
    );
    assert.ok(tokenData);
    assert.strictEqual(tokenData!.kind, "data");
    assert.strictEqual(tokenData!.name, "Token");
    assert.deepStrictEqual(tokenData!.typeParams, []);
    assert.deepStrictEqual(tokenData!.constructors, [
      { name: "T_Tagged", fields: [mkTypeVariable("U8")] },
      {
        name: "T_Ident",
        fields: [typeApp(mkTypeVariable("List"), mkTypeVariable("U8"))],
      },
      {
        name: "T_Nat",
        fields: [typeApp(mkTypeVariable("List"), mkTypeVariable("U8"))],
      },
    ]);
  });

  it("parses multiple definitions", () => {
    const input = loadInput("church.trip", __dirname);
    const program = parseTripLang(input);
    const typeVar = (name: string) => ({
      kind: "type-var" as const,
      typeName: name,
    });
    const X = typeVar("X");
    const A = typeVar("A");

    assert.deepStrictEqual(program, {
      kind: "program",
      terms: [
        { kind: "module", name: "Church" },
        {
          kind: "type",
          name: "Nat",
          type: {
            kind: "forall",
            typeVar: "X",
            body: arrow(arrow(X, X), arrow(X, X)),
          },
        },
        {
          kind: "poly",
          name: "id",
          type: undefined,
          term: mkSystemFTAbs("A", mkSystemFAbs("x", A, mkSystemFVar("x"))),
        },
        {
          kind: "combinator",
          name: "complex",
          term: apply(
            apply(S, apply(K, apply(apply(S, I), I))),
            apply(
              apply(S, apply(apply(S, apply(K, S)), K)),
              apply(K, apply(apply(S, I), I)),
            ),
          ),
        },
        {
          kind: "poly",
          name: "two",
          type: typeVar("Nat"),
          term: createSystemFApplication(
            mkSystemFVar("succ"),
            createSystemFApplication(
              mkSystemFVar("succ"),
              mkSystemFVar("zero"),
            ),
          ),
        },
        {
          kind: "poly",
          name: "main",
          type: typeVar("Nat"),
          term: mkSystemFVar("two"),
        },
      ],
    });
  });

  it("parses poly definition with explicit type annotation", () => {
    const input = loadInput("polyWithType.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;
    assert.deepStrictEqual(moduleDecl, {
      kind: "module",
      name: "PolyWithType",
    });
    assert.deepStrictEqual(term, {
      kind: "poly",
      name: "id",
      type: {
        kind: "forall",
        typeVar: "a",
        body: arrow(
          { kind: "type-var", typeName: "a" },
          { kind: "type-var", typeName: "a" },
        ),
      },
      term: mkSystemFTAbs(
        "a",
        mkSystemFAbs(
          "x",
          { kind: "type-var", typeName: "a" },
          mkSystemFVar("x"),
        ),
      ),
    });
  });

  it("parses poly definition without explicit type annotation", () => {
    const input = loadInput("typedNoType.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;
    assert.deepStrictEqual(moduleDecl, {
      kind: "module",
      name: "TypedNoType",
    });
    assert.deepStrictEqual(term, {
      kind: "poly",
      name: "id",
      type: undefined,
      term: mkSystemFAbs(
        "x",
        { kind: "type-var", typeName: "Int" },
        mkSystemFVar("x"),
      ),
    });
  });

  it("rejects legacy typed definitions", () => {
    const input = "module Legacy\ntyped id = \\x:Int => x";
    assert.throws(
      () => parseTripLang(input),
      /expected definition keyword, found typed/,
    );
  });

  it("rejects legacy untyped definitions", () => {
    const input = "module Legacy\nuntyped id = \\x => x";
    assert.throws(
      () => parseTripLang(input),
      /expected definition keyword, found untyped/,
    );
  });

  it("parses module definition", () => {
    const input = "module MyModule";
    const [term] = parseTripLang(input).terms;
    assert.deepStrictEqual(term, {
      kind: "module",
      name: "MyModule",
    });
  });

  it("parses import definition", () => {
    const input = "import Foo bar";
    const [term] = parseTripLang(input).terms;
    assert.deepStrictEqual(term, {
      kind: "import",
      name: "Foo",
      ref: "bar",
    });
  });

  it("parses export definition", () => {
    const input = "export Baz";
    const [term] = parseTripLang(input).terms;
    assert.deepStrictEqual(term, {
      kind: "export",
      name: "Baz",
    });
  });

  it("parses combined module/import/export definitions from file", () => {
    const input = loadInput("moduleCombo.trip", __dirname);
    const program = parseTripLang(input);
    assert.deepStrictEqual(program, {
      kind: "program",
      terms: [
        { kind: "module", name: "MyModule" },
        { kind: "import", name: "Foo", ref: "bar" },
        { kind: "export", name: "Baz" },
      ],
    });
  });

  it("rejects module names containing dots", () => {
    const input = "module My.Module";
    assert.throws(() => parseTripLang(input), /expected an identifier/);
  });

  it("rejects opaque without type keyword", () => {
    const input = "opaque something somethingElse";
    assert.throws(
      () => parseTripLang(input),
      /opaque must be followed by type and a type name/,
    );
  });

  it("rejects native without type annotation", () => {
    const input = "native myNative = something";
    assert.throws(
      () => parseTripLang(input),
      /native requires a type annotation/,
    );
  });
});

describe("parse single poly", () => {
  it("parses single poly", () => {
    const input = 'poly foo = "foo"';
    const result = parseTripLang(input);

    assert.strictEqual(result.kind, "program");
    assert.strictEqual(result.terms.length, 1);
    const term = requiredAt(result.terms, 0, "expected poly term");

    if (term.kind !== "poly") {
      throw new Error(`expected 'poly' term, got '${term.kind}'`);
    }
    assert.strictEqual(term.name, "foo");
    assert.strictEqual(term.type, undefined);

    // The string literal "foo" is desugared into a List U8 term:
    // cons [U8] (#u8(102)) (cons [U8] (#u8(111)) (cons [U8] (#u8(111)) (nil [U8])))
    const expectedCodes = [102, 111, 111];
    const decodeU8Term = (t: SystemFTerm): number => {
      if (t.kind !== "systemF-var") {
        throw new Error(`expected systemF-var for u8 literal, got ${t.kind}`);
      }
      const u8Match = /^__trip_u8_(\d+)$/.exec(t.name);
      if (!u8Match) {
        throw new Error(`expected __trip_u8_ literal, got ${t.name}`);
      }
      return parseInt(u8Match[1]!, 10);
    };
    let current: SystemFTerm = term.term;
    for (const code of expectedCodes) {
      const outerApp = expectSystemFApp(current);

      // left is (cons [U8] <head>)
      const consApp = expectSystemFApp(outerApp.lft);
      const consTypeApp = expectSystemFTypeApp(consApp.lft);
      const consVar = expectSystemFVar(consTypeApp.term);
      assert.strictEqual(consVar.name, "cons");
      assert.strictEqual(unparseSystemFType(consTypeApp.typeArg), "U8");

      // head is a u8 literal whose decoded value matches
      const decoded = decodeU8Term(consApp.rgt);
      assert.strictEqual(decoded, code);

      // tail
      current = outerApp.rgt;
    }

    // tail is (nil [U8])
    const nilApp = expectSystemFTypeApp(current);
    const nilVar = expectSystemFVar(nilApp.term);
    assert.strictEqual(nilVar.name, "nil");
    assert.strictEqual(unparseSystemFType(nilApp.typeArg), "U8");
  });
});

import { expect } from "chai";
import { readFileSync } from "node:fs";
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
import { createApplication, mkVar } from "../../lib/terms/lambda.ts";
import { createTypedApplication } from "../../lib/types/typedLambda.ts";
import { arrow, mkTypeVariable, typeApp } from "../../lib/types/types.ts";
import { apply } from "../../lib/ski/expression.ts";
import { I, K, S } from "../../lib/ski/terminal.ts";
import { loadInput } from "../util/fileLoader.ts";
import { makeTypedChurchNumeral } from "../../lib/types/natLiteral.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const expectSystemFApp = (t: SystemFTerm) => {
  expect(t.kind).to.equal("non-terminal");
  return t as Extract<SystemFTerm, { kind: "non-terminal" }>;
};

const expectSystemFTypeApp = (t: SystemFTerm) => {
  expect(t.kind).to.equal("systemF-type-app");
  return t as Extract<SystemFTerm, { kind: "systemF-type-app" }>;
};

const expectSystemFVar = (t: SystemFTerm) => {
  expect(t.kind).to.equal("systemF-var");
  return t as Extract<SystemFTerm, { kind: "systemF-var" }>;
};

Deno.test("parseTripLang", async (t) => {
  await t.step("parses polymorphic definitions", () => {
    const input = loadInput("polyId.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;

    expect(moduleDecl).to.deep.equal({
      kind: "module",
      name: "PolyId",
    });
    expect(term).to.deep.equal({
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

  await t.step("parses recursive polymorphic definitions", () => {
    const input = loadInput("polyRec.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;

    expect(moduleDecl).to.deep.equal({
      kind: "module",
      name: "PolyRec",
    });
    expect(term).to.deep.equal({
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

  await t.step("parses typed definitions with explicit types", () => {
    const input = loadInput("typedInc.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;

    expect(moduleDecl).to.deep.equal({
      kind: "module",
      name: "TypedInc",
    });
    expect(term).to.deep.equal({
      kind: "typed",
      name: "inc",
      type: arrow(
        { kind: "type-var", typeName: "Int" },
        { kind: "type-var", typeName: "Int" },
      ),
      term: {
        kind: "typed-lambda-abstraction",
        varName: "x",
        ty: { kind: "type-var", typeName: "Int" },
        body: createTypedApplication(
          createTypedApplication(mkVar("plus"), mkVar("x")),
          makeTypedChurchNumeral(1n),
        ),
      },
    });
  });

  await t.step("parses untyped definitions", () => {
    const input = loadInput("untypedDouble.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;

    expect(moduleDecl).to.deep.equal({
      kind: "module",
      name: "UntypedDouble",
    });
    expect(term).to.deep.equal({
      kind: "untyped",
      name: "double",
      term: {
        kind: "lambda-abs",
        name: "x",
        body: createApplication(
          mkVar("x"),
          mkVar("x"),
        ),
      },
    });
  });

  await t.step("parses complex combinator definitions", () => {
    const input = loadInput("combinatorY.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;

    expect(moduleDecl).to.deep.equal({
      kind: "module",
      name: "CombinatorY",
    });
    expect(term).to.deep.equal({
      "kind": "combinator",
      "name": "Y",
      "term": apply(
        apply(
          S,
          apply(
            K,
            apply(
              apply(S, I),
              I,
            ),
          ),
        ),
        apply(
          apply(
            S,
            apply(
              apply(
                S,
                apply(K, S),
              ),
              K,
            ),
          ),
          apply(
            K,
            apply(
              apply(S, I),
              I,
            ),
          ),
        ),
      ),
    });
  });

  await t.step("parses type definitions correctly", () => {
    const input = loadInput("typeNat.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;

    const typeVar = (name: string) => ({
      kind: "type-var" as const,
      typeName: name,
    });
    const X = typeVar("X");

    expect(moduleDecl).to.deep.equal({
      kind: "module",
      name: "TypeNat",
    });
    expect(term).to.deep.equal({
      kind: "type",
      name: "Nat",
      type: {
        kind: "forall",
        typeVar: "X",
        body: arrow(
          arrow(X, X),
          arrow(X, X),
        ),
      },
    });
  });

  await t.step("parses data definitions", () => {
    const input = loadInput("dataMaybe.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;

    expect(moduleDecl).to.deep.equal({
      kind: "module",
      name: "DataMaybe",
    });
    expect(term).to.deep.equal({
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

  await t.step(
    "parses data definitions with leading pipe and type-application field types",
    // Parser must: (1) accept optional leading | and whitespace before the first
    // constructor (data T = \n  | C1); (2) skip whitespace before field types so
    // "T_Keyword (List Nat)" parses; (3) allow type applications like (List Nat)
    // in field types, with space between type and argument.
    () => {
      const input = `module Lexer
data Token =
  | T_LParen
  | T_Keyword (List Nat)
  | T_EOF`;
      const [moduleDecl, term] = parseTripLang(input).terms;

      expect(moduleDecl).to.deep.equal({
        kind: "module",
        name: "Lexer",
      });
      expect(term).to.deep.equal({
        kind: "data",
        name: "Token",
        typeParams: [],
        constructors: [
          { name: "T_LParen", fields: [] },
          {
            name: "T_Keyword",
            fields: [
              typeApp(mkTypeVariable("List"), mkTypeVariable("Nat")),
            ],
          },
          { name: "T_EOF", fields: [] },
        ],
      });
    },
  );

  await t.step("parses lib/compiler/lexer.trip Token ADT", () => {
    const lexerPath = join(
      __dirname,
      "..",
      "..",
      "lib",
      "compiler",
      "lexer.trip",
    );
    const input = readFileSync(lexerPath, "utf-8").trim();
    const program = parseTripLang(input);

    // Lightweight "whole file" sanity checks (beyond just the Token ADT)
    expect(program.kind).to.equal("program");
    expect(program.terms[0]).to.deep.equal({ kind: "module", name: "Lexer" });
    expect(
      program.terms.some((t) => t.kind === "export" && t.name === "Token"),
      "expected lexer.trip to export Token",
    ).to.equal(true);
    expect(
      program.terms.some((t) => t.kind === "poly" && t.name === "tokenize"),
      "expected lexer.trip to define poly tokenize",
    ).to.equal(true);

    // Assert that every top-level TripLang definition in lexer.trip
    // has a corresponding entry in the parsed program.
    //
    // NOTE: This list is intentionally hardcoded (no regex parsing) so that
    // changes to lexer.trip require an explicit update here.
    const expectedImports = [
      { name: "Nat", ref: "Nat" },
      { name: "Nat", ref: "toBin" },
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
      { name: "Prelude", ref: "Bin" },
      { name: "Prelude", ref: "addBin" },
      { name: "Prelude", ref: "mulBin" },
      { name: "Prelude", ref: "subBin" },
      { name: "Prelude", ref: "eqBin" },
      { name: "Prelude", ref: "lteBin" },
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
      "T_Keyword",
      "T_Ident",
      "T_Nat",
      "T_EOF",
      "tokenize",
      "tokenizeBin",
      "kwPoly",
      "isKeywordPoly",
      "binFromDigitList",
      "mapResult",
    ] as const;

    const expectedData = ["Token"] as const;

    const expectedPoly = [
      "reverse",
      "tokenizeAcc",
      "tokenize",
    ] as const;

    for (const { name, ref } of expectedImports) {
      expect(
        program.terms.some((t) =>
          t.kind === "import" && t.name === name && t.ref === ref
        ),
        `expected import ${name} ${ref}`,
      ).to.equal(true);
    }

    for (const name of expectedExports) {
      expect(
        program.terms.some((t) => t.kind === "export" && t.name === name),
        `expected export ${name}`,
      ).to.equal(true);
    }

    for (const name of expectedData) {
      expect(
        program.terms.some((t) => t.kind === "data" && t.name === name),
        `expected data ${name} = ...`,
      ).to.equal(true);
    }

    for (const name of expectedPoly) {
      expect(
        program.terms.some((t) => t.kind === "poly" && t.name === name),
        `expected poly ${name} = ...`,
      ).to.equal(true);
    }

    const tokenData = program.terms.find(
      (term): term is typeof term & { kind: "data"; name: string } =>
        term.kind === "data" && term.name === "Token",
    );
    expect(tokenData).to.be.ok;
    expect(tokenData!.kind).to.equal("data");
    expect(tokenData!.name).to.equal("Token");
    expect(tokenData!.typeParams).to.deep.equal([]);
    expect(tokenData!.constructors).to.deep.equal([
      { name: "T_LParen", fields: [] },
      { name: "T_RParen", fields: [] },
      { name: "T_LBrace", fields: [] },
      { name: "T_RBrace", fields: [] },
      { name: "T_LBracket", fields: [] },
      { name: "T_RBracket", fields: [] },
      { name: "T_Backslash", fields: [] },
      { name: "T_Arrow", fields: [] },
      { name: "T_FatArrow", fields: [] },
      { name: "T_Eq", fields: [] },
      { name: "T_Colon", fields: [] },
      { name: "T_Hash", fields: [] },
      { name: "T_Pipe", fields: [] },
      { name: "T_Dot", fields: [] },
      { name: "T_Comma", fields: [] },
      {
        name: "T_Keyword",
        fields: [typeApp(mkTypeVariable("List"), mkTypeVariable("Bin"))],
      },
      {
        name: "T_Ident",
        fields: [typeApp(mkTypeVariable("List"), mkTypeVariable("Bin"))],
      },
      {
        name: "T_Nat",
        fields: [mkTypeVariable("Bin")],
      },
      { name: "T_EOF", fields: [] },
    ]);
  });

  await t.step("parses multiple definitions", () => {
    const input = loadInput("church.trip", __dirname);
    const program = parseTripLang(input);
    const typeVar = (name: string) => ({
      kind: "type-var" as const,
      typeName: name,
    });
    const X = typeVar("X");
    const A = typeVar("A");

    expect(program).to.deep.equal({
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
            apply(
              S,
              apply(
                K,
                apply(
                  apply(S, I),
                  I,
                ),
              ),
            ),
            apply(
              apply(
                S,
                apply(
                  apply(S, apply(K, S)),
                  K,
                ),
              ),
              apply(
                K,
                apply(apply(S, I), I),
              ),
            ),
          ),
        },
        {
          kind: "typed",
          name: "two",
          type: typeVar("Nat"),
          term: createTypedApplication(
            mkVar("succ"),
            createTypedApplication(mkVar("succ"), mkVar("zero")),
          ),
        },
        {
          kind: "typed",
          name: "main",
          type: typeVar("Nat"),
          term: mkVar("two"),
        },
      ],
    });
  });

  await t.step("parses poly definition with explicit type annotation", () => {
    const input = loadInput("polyWithType.trip", __dirname);
    const [moduleDecl, term] = parseTripLang(input).terms;
    expect(moduleDecl).to.deep.equal({
      kind: "module",
      name: "PolyWithType",
    });
    expect(term).to.deep.equal({
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

  await t.step(
    "parses typed definition without explicit type annotation",
    () => {
      const input = loadInput("typedNoType.trip", __dirname);
      const [moduleDecl, term] = parseTripLang(input).terms;
      expect(moduleDecl).to.deep.equal({
        kind: "module",
        name: "TypedNoType",
      });
      expect(term).to.deep.equal({
        kind: "typed",
        name: "id",
        type: undefined,
        term: {
          kind: "typed-lambda-abstraction",
          varName: "x",
          ty: { kind: "type-var", typeName: "Int" },
          body: { kind: "lambda-var", name: "x" },
        },
      });
    },
  );

  await t.step("parses module definition", () => {
    const input = "module MyModule";
    const [term] = parseTripLang(input).terms;
    expect(term).to.deep.equal({
      kind: "module",
      name: "MyModule",
    });
  });

  await t.step("parses import definition", () => {
    const input = "import Foo bar";
    const [term] = parseTripLang(input).terms;
    expect(term).to.deep.equal({
      kind: "import",
      name: "Foo",
      ref: "bar",
    });
  });

  await t.step("parses export definition", () => {
    const input = "export Baz";
    const [term] = parseTripLang(input).terms;
    expect(term).to.deep.equal({
      kind: "export",
      name: "Baz",
    });
  });

  await t.step(
    "parses combined module/import/export definitions from file",
    () => {
      const input = loadInput("moduleCombo.trip", __dirname);
      const program = parseTripLang(input);
      expect(program).to.deep.equal({
        kind: "program",
        terms: [
          { kind: "module", name: "MyModule" },
          { kind: "import", name: "Foo", ref: "bar" },
          { kind: "export", name: "Baz" },
        ],
      });
    },
  );

  await t.step("rejects module names containing dots", () => {
    const input = "module My.Module";
    expect(() => parseTripLang(input)).to.throw(
      "expected an identifier",
    );
  });
});

Deno.test("parse single poly", async (t) => {
  await t.step("parses single poly", () => {
    const input = 'poly foo = "foo"';
    const result = parseTripLang(input);

    expect(result.kind).to.equal("program");
    expect(result.terms).to.have.length(1);
    const [term] = result.terms;

    if (term.kind !== "poly") {
      throw new Error(`expected 'poly' term, got '${term.kind}'`);
    }
    expect(term.name).to.equal("foo");
    expect(term.type).to.equal(undefined);

    // The string literal "foo" is desugared into a Bin list term:
    // cons (bin 102) (cons (bin 111) (cons (bin 111) (nil Bin)))
    const expectedCodes = [102, 111, 111];
    const decodeBinTerm = (t: SystemFTerm): number => {
      if (t.kind === "systemF-var") {
        if (t.name !== "BZ") {
          throw new Error(`expected 'BZ', got '${t.name}'`);
        }
        return 0;
      }
      const app = expectSystemFApp(t);
      const ctor = expectSystemFVar(app.lft);
      const rest = decodeBinTerm(app.rgt);
      if (ctor.name === "B0") {
        return rest * 2;
      }
      if (ctor.name === "B1") {
        return rest * 2 + 1;
      }
      throw new Error(`expected 'B0' or 'B1', got '${ctor.name}'`);
    };
    let current: SystemFTerm = term.term;
    for (const code of expectedCodes) {
      const outerApp = expectSystemFApp(current);

      // left is (cons [Bin] <head>)
      const consApp = expectSystemFApp(outerApp.lft);
      const consTypeApp = expectSystemFTypeApp(consApp.lft);
      const consVar = expectSystemFVar(consTypeApp.term);
      expect(consVar.name).to.equal("cons");

      // head is a Bin constructor chain whose decoded value matches
      const decoded = decodeBinTerm(consApp.rgt);
      expect(decoded).to.equal(code);

      // tail
      current = outerApp.rgt;
    }

    // tail is (nil [Bin])
    const nilApp = expectSystemFTypeApp(current);
    const nilVar = expectSystemFVar(nilApp.term);
    expect(nilVar.name).to.equal("nil");
  });
});

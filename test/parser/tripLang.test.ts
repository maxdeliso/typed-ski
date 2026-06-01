import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { compilerTripModuleSourcePath } from "../../lib/compiler/bootstrapModules.ts";
import { parseTripLang } from "../../lib/parser/tripLang.ts";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";
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

const srcDir = join(workspaceRoot, "test", "parser");

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
    const input = loadInput("polyId.trip", srcDir);
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
    const input = loadInput("polyRec.trip", srcDir);
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
      term: mkSystemFVar("fact"),
    });
  });

  it("parses poly definitions with explicit types", () => {
    const input = loadInput("typedInc.trip", srcDir);
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
    const input = loadInput("combinatorY.trip", srcDir);
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
    const input = loadInput("typeNat.trip", srcDir);
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

  it("parses bare type declarations with optional parameters", () => {
    const program = parseTripLang(`module Types
type Bool
type List A
poly id = #A => \\x : A => x
`);

    assert.deepStrictEqual(program.terms.slice(0, 3), [
      { kind: "module", name: "Types" },
      { kind: "type", name: "Bool", type: mkTypeVariable("Bool") },
      { kind: "type", name: "List", type: mkTypeVariable("List") },
    ]);
    assert.strictEqual(
      requiredAt(program.terms, 3, "poly definition").kind,
      "poly",
    );
  });

  it("parses data definitions", () => {
    const input = loadInput("dataMaybe.trip", srcDir);
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

  it("parses data definitions with leading pipe and type-application field types", () => {
    /*
      in field types, with space between type and argument. 
      "T_Keyword (List Nat)" parses; 
      allow type applications like (List Nat) 
      constructor (data T = \n  | C1); (2) skip whitespace before field types so 
      Parser must: (1) accept optional leading | and whitespace before the first
     */

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

  it("parses the bootstrap Lexer module Token ADT", () => {
    const input = loadTripSourceFileSync(
      compilerTripModuleSourcePath("Lexer"),
    ).trim();
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
      "T_KwNative",
      "T_KwOpaque",
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
    const input = loadInput("church.trip", srcDir);
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
    const input = loadInput("polyWithType.trip", srcDir);
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
    const input = loadInput("typedNoType.trip", srcDir);
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

  it("marks opaque type definitions", () => {
    const input = "opaque type Handle";
    const [term] = parseTripLang(input).terms;
    assert.deepStrictEqual(term, {
      kind: "type",
      name: "Handle",
      opaque: true,
      type: mkTypeVariable("Handle"),
    });
  });

  it("parses combined module/import/export definitions from file", () => {
    const input = loadInput("moduleCombo.trip", srcDir);
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

describe("parse cond expression", () => {
  it("parses cond expression with multiple arms", () => {
    const input = `poly foo =
      cond [Maybe U8] {
        | true => Some [U8] 1
        | false => None [U8]
        | otherwise => None [U8]
      }`;
    const result = parseTripLang(input);

    assert.strictEqual(result.kind, "program");
    assert.strictEqual(result.terms.length, 1);
    const term = result.terms[0]!;
    assert.strictEqual(term.kind, "poly");
    assert.strictEqual(term.name, "foo");
  });

  it("does not capture an outer u when desugaring cond branches", () => {
    const input = `poly foo =
      \\u : U8 =>
        cond [U8] {
          | true => u
          | otherwise => 0
        }`;
    const result = parseTripLang(input);
    const term = requiredAt(result.terms, 0, "expected poly term");
    assert.strictEqual(term.kind, "poly");
    assert.strictEqual(term.term.kind, "systemF-abs");
    assert.strictEqual(term.term.name, "u");

    const ifApp = expectSystemFApp(term.term.body);
    const elseBranch = ifApp.rgt;
    assert.strictEqual(elseBranch.kind, "systemF-abs");
    assert.notStrictEqual(elseBranch.name, "u");

    const ifThenApp = expectSystemFApp(ifApp.lft);
    const thenBranch = ifThenApp.rgt;
    assert.strictEqual(thenBranch.kind, "systemF-abs");
    assert.notStrictEqual(thenBranch.name, "u");
    assert.deepStrictEqual(thenBranch.body, mkSystemFVar("u"));
  });
});

describe("parse do expression", () => {
  it("parses do expression with monadic binds and guards", () => {
    const input = `poly foo =
      do [Result U8 U8] {
        x <- readLine
        MkLine magic = x
        assert true else 1
        return Ok [U8] [U8] magic
      }`;
    const result = parseTripLang(input);

    assert.strictEqual(result.kind, "program");
    assert.strictEqual(result.terms.length, 1);
    const term = result.terms[0]!;
    assert.strictEqual(term.kind, "poly");
    assert.strictEqual(term.name, "foo");

    // Let's assert on the desugared term structure
    assert.strictEqual(term.term.kind, "systemF-match");
    const firstMatch = term.term;
    assert.strictEqual(firstMatch.scrutinee.kind, "systemF-var");
    assert.strictEqual(firstMatch.scrutinee.name, "readLine");
    assert.strictEqual(firstMatch.arms.length, 2);

    const errArm = firstMatch.arms[0]!;
    assert.strictEqual(errArm.constructorName, "Err");
    assert.deepStrictEqual(errArm.params, ["e"]);

    const okArm = firstMatch.arms[1]!;
    assert.strictEqual(okArm.constructorName, "Ok");
    assert.deepStrictEqual(okArm.params, ["x"]);

    const secondMatch = okArm.body;
    assert.strictEqual(secondMatch.kind, "systemF-match");
    assert.strictEqual(secondMatch.scrutinee.kind, "systemF-var");
    assert.strictEqual(secondMatch.scrutinee.name, "x");
    assert.strictEqual(secondMatch.arms.length, 1);

    const mkLineArm = secondMatch.arms[0]!;
    assert.strictEqual(mkLineArm.constructorName, "MkLine");
    assert.deepStrictEqual(mkLineArm.params, ["magic"]);

    // assert true else 1 desugars to application of `if`
    const assertApp = mkLineArm.body;
    assert.strictEqual(assertApp.kind, "non-terminal"); // application is non-terminal in binary representation
  });
});

describe("parse list literal", () => {
  it("parses list literal in a poly definition", () => {
    const input = "poly foo = {U8 | 102 111 111}";
    const result = parseTripLang(input);

    assert.strictEqual(result.kind, "program");
    assert.strictEqual(result.terms.length, 1);
    const term = requiredAt(result.terms, 0, "expected poly term");

    if (term.kind !== "poly") {
      throw new Error(`expected 'poly' term, got '${term.kind}'`);
    }
    assert.strictEqual(term.name, "foo");
    assert.strictEqual(term.type, undefined);

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
      const consApp = expectSystemFApp(outerApp.lft);
      const consTypeApp = expectSystemFTypeApp(consApp.lft);
      const consVar = expectSystemFVar(consTypeApp.term);
      assert.strictEqual(consVar.name, "cons");
      assert.strictEqual(unparseSystemFType(consTypeApp.typeArg), "U8");

      const decoded = decodeU8Term(consApp.rgt);
      assert.strictEqual(decoded, code);
      current = outerApp.rgt;
    }

    const nilApp = expectSystemFTypeApp(current);
    const nilVar = expectSystemFVar(nilApp.term);
    assert.strictEqual(nilVar.name, "nil");
    assert.strictEqual(unparseSystemFType(nilApp.typeArg), "U8");
  });
});

describe("Haskell-style comments", () => {
  const expectPoly = (input: string) => {
    const term = requiredAt(parseTripLang(input).terms, 0, "expected poly");
    if (term.kind !== "poly") {
      throw new Error(`expected 'poly' term, got '${term.kind}'`);
    }
    return term;
  };

  // Walks the desugared `cons [U8] head tail ... (nil [U8])` list a string
  // literal produces and reconstructs the original text. Used to prove that
  // comment delimiters inside a string stay literal.
  const isNilU8 = (t: SystemFTerm): boolean =>
    t.kind === "systemF-type-app" &&
    t.term.kind === "systemF-var" &&
    t.term.name === "nil";

  const decodeU8ListString = (t: SystemFTerm): string => {
    const codes: number[] = [];
    let current = t;
    while (!isNilU8(current)) {
      const outer = expectSystemFApp(current); // (cons [U8] head) tail
      const consApp = expectSystemFApp(outer.lft); // (cons [U8]) head
      const head = expectSystemFVar(consApp.rgt);
      const match = /^__trip_u8_(\d+)$/.exec(head.name);
      if (!match) {
        throw new Error(`expected u8 list element, got '${head.name}'`);
      }
      codes.push(parseInt(match[1]!, 10));
      current = outer.rgt;
    }
    return String.fromCharCode(...codes);
  };

  it("parses a comment-laden file identically to its bare twin", () => {
    const commented = loadInput("comments.trip", srcDir);
    const bare = loadInput("church.trip", srcDir);
    assert.deepStrictEqual(parseTripLang(commented), parseTripLang(bare));
  });

  it("ignores a line comment on its own line between definitions", () => {
    const commented = "module M\n-- a standalone comment\npoly id = \\x:A => x";
    const bare = "module M\npoly id = \\x:A => x";
    assert.deepStrictEqual(parseTripLang(commented), parseTripLang(bare));
  });

  it("ignores a trailing line comment after a definition", () => {
    const commented = "poly id = \\x:A => x  -- the identity";
    const bare = "poly id = \\x:A => x";
    assert.deepStrictEqual(parseTripLang(commented), parseTripLang(bare));
  });

  it("requires no whitespace before a trailing line comment", () => {
    const commented = "poly id = \\x:A => x--touching the comment";
    const bare = "poly id = \\x:A => x";
    assert.deepStrictEqual(parseTripLang(commented), parseTripLang(bare));
  });

  it("ignores block comments, including between and inside tokens", () => {
    const commented =
      "module M {- here -}\npoly id = {- a -} #A => \\x {- b -} : A => x";
    const bare = "module M\npoly id = #A => \\x : A => x";
    assert.deepStrictEqual(parseTripLang(commented), parseTripLang(bare));
  });

  it("supports nested block comments", () => {
    const commented = "module M\n{- outer {- inner -} still outer -}\nexport M";
    const bare = "module M\nexport M";
    assert.deepStrictEqual(parseTripLang(commented), parseTripLang(bare));
  });

  it("treats a trailing comment on a combinator line as the end of the term", () => {
    const commented = "combinator k = K  -- the K combinator";
    const bare = "combinator k = K";
    assert.deepStrictEqual(parseTripLang(commented), parseTripLang(bare));
  });

  it("handles an inline block comment within a combinator term", () => {
    const commented = "combinator s = S {- subst -} K I";
    const bare = "combinator s = S K I";
    assert.deepStrictEqual(parseTripLang(commented), parseTripLang(bare));
  });

  it("parses a program that is only comments as having no terms", () => {
    const program = parseTripLang(
      "-- nothing here\n{- nor here {- nested -} -}\n",
    );
    assert.deepStrictEqual(program, { kind: "program", terms: [] });
  });

  it("does not mistake the arrow tokens for line comments", () => {
    // `->` and `=>` contain a single dash at most; only `--` is a comment.
    const program = parseTripLang("module M\ntype F = A->B->C");
    const typeTerm = requiredAt(program.terms, 1, "expected type");
    assert.strictEqual(typeTerm.kind, "type");
    assert.deepStrictEqual(
      typeTerm,
      parseTripLang("module M\ntype F = A -> B -> C").terms[1],
    );
  });

  it("does not merge a block-comment close with an adjacent arrow", () => {
    const commented = "module M\ntype F = A {- t -}->B";
    const bare = "module M\ntype F = A -> B";
    assert.deepStrictEqual(parseTripLang(commented), parseTripLang(bare));
  });

  it("keeps comment delimiters inside a string literal literal", () => {
    const term = expectPoly('poly s = "a--b{-c-}d"');
    assert.strictEqual(decodeU8ListString(term.term), "a--b{-c-}d");
  });

  it("keeps a dash inside a character literal literal", () => {
    const term = expectPoly("poly d = '-'");
    assert.deepStrictEqual(term.term, mkSystemFVar("__trip_u8_45"));
  });
});

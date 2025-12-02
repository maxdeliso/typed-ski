import { expect } from "chai";
import { dirname } from "node:path";
import { parseTripLang } from "../../lib/parser/tripLang.ts";
import { fileURLToPath } from "node:url";
import {
  mkSystemFAbs,
  mkSystemFTAbs,
  mkSystemFVar,
} from "../../lib/terms/systemF.ts";
import { createApplication, mkVar } from "../../lib/terms/lambda.ts";
import { createTypedApplication } from "../../lib/types/typedLambda.ts";
import { arrow } from "../../lib/types/types.ts";
import { apply } from "../../lib/ski/expression.ts";
import { I, K, S } from "../../lib/ski/terminal.ts";
import { loadInput } from "../util/fileLoader.ts";
import { makeTypedChurchNumeral } from "../../lib/types/natLiteral.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

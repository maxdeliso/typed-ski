import { expect } from "npm:chai";
import { dirname } from "node:path";
import { createParserState } from "../../lib/parser/parserState.ts";
import {
  parseTripLang,
  parseTripLangDefinition,
} from "../../lib/parser/tripLang.ts";
import { fileURLToPath } from "node:url";
import {
  mkSystemFAbs,
  mkSystemFTAbs,
  mkSystemFVar,
} from "../../lib/terms/systemF.ts";
import { cons } from "../../lib/cons.ts";
import { mkVar } from "../../lib/terms/lambda.ts";
import type { TypedLambda } from "../../lib/types/typedLambda.ts";
import type { SKIExpression } from "../../lib/ski/expression.ts";
import { I, K, S } from "../../lib/ski/terminal.ts";
import { loadInput } from "../util/fileLoader.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

Deno.test("parseTripLang", async (t) => {
  await t.step("parses polymorphic definitions", () => {
    const input = loadInput("polyId.trip", __dirname);
    const [term] = parseTripLangDefinition(createParserState(input));

    expect(term).to.deep.equal({
      kind: "poly",
      name: "id",
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
    const [term] = parseTripLangDefinition(createParserState(input));

    expect(term).to.deep.equal({
      kind: "typed",
      name: "inc",
      type: cons(
        { kind: "type-var", typeName: "Int" },
        { kind: "type-var", typeName: "Int" },
      ),
      term: {
        kind: "typed-lambda-abstraction",
        varName: "x",
        ty: { kind: "type-var", typeName: "Int" },
        body: cons<TypedLambda>(
          cons(mkVar("plus"), mkVar("x")),
          mkVar("1"),
        ),
      },
    });
  });

  await t.step("parses untyped definitions", () => {
    const input = loadInput("untypedDouble.trip", __dirname);
    const [term] = parseTripLangDefinition(createParserState(input));

    expect(term).to.deep.equal({
      kind: "untyped",
      name: "double",
      term: {
        kind: "lambda-abs",
        name: "x",
        body: cons(
          mkVar("x"),
          mkVar("x"),
        ),
      },
    });
  });

  await t.step("parses complex combinator definitions", () => {
    const input = loadInput("combinatorY.trip", __dirname);
    const [term] = parseTripLangDefinition(createParserState(input));

    expect(term).to.deep.equal({
      "kind": "combinator",
      "name": "Y",
      "term": cons(
        cons<SKIExpression>(
          S,
          cons<SKIExpression>(
            K,
            cons<SKIExpression>(
              cons<SKIExpression>(S, I),
              I,
            ),
          ),
        ),
        cons<SKIExpression>(
          cons<SKIExpression>(
            S,
            cons<SKIExpression>(
              cons<SKIExpression>(
                S,
                cons<SKIExpression>(K, S),
              ),
              K,
            ),
          ),
          cons<SKIExpression>(
            K,
            cons<SKIExpression>(
              cons<SKIExpression>(S, I),
              I,
            ),
          ),
        ),
      ),
    });
  });

  await t.step("parses type definitions correctly", () => {
    const input = loadInput("typeNat.trip", __dirname);
    const [term] = parseTripLangDefinition(createParserState(input));

    const typeVar = (name: string) => ({ kind: "type-var", typeName: name });
    const X = typeVar("X");

    expect(term).to.deep.equal({
      kind: "type",
      name: "Nat",
      type: {
        kind: "forall",
        typeVar: "X",
        body: cons(
          cons(X, X),
          cons(X, X),
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
        {
          kind: "type",
          name: "Nat",
          type: {
            kind: "forall",
            typeVar: "X",
            body: cons(cons(X, X), cons(X, X)),
          },
        },
        {
          kind: "poly",
          name: "id",
          term: mkSystemFTAbs("A", mkSystemFAbs("x", A, mkSystemFVar("x"))),
        },
        {
          kind: "combinator",
          name: "complex",
          term: cons<SKIExpression>(
            cons<SKIExpression>(
              S,
              cons<SKIExpression>(
                K,
                cons<SKIExpression>(
                  cons<SKIExpression>(S, I),
                  I,
                ),
              ),
            ),
            cons<SKIExpression>(
              cons<SKIExpression>(
                S,
                cons<SKIExpression>(
                  cons<SKIExpression>(S, cons<SKIExpression>(K, S)),
                  K,
                ),
              ),
              cons<SKIExpression>(
                K,
                cons<SKIExpression>(cons<SKIExpression>(S, I), I),
              ),
            ),
          ),
        },
        {
          kind: "typed",
          name: "two",
          type: typeVar("Nat"),
          term: cons<TypedLambda>(
            mkVar("succ"),
            cons<TypedLambda>(mkVar("succ"), mkVar("zero")),
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
});

import { test } from "node:test";
import { assert } from "../../util/assertions.ts";
import {
  unparseProgram,
  unparseTerm,
} from "../../../lib/meta/frontend/unparse.ts";
import { parseTripLang } from "../../../lib/parser/tripLang.ts";
import { requiredAt } from "../../util/required.ts";
import { mkUntypedAbs, mkVar } from "../../../lib/terms/lambda.ts";

test("unparseTerm", async (t) => {
  await t.test("should unparse a poly definition", () => {
    const input = "module Test\npoly id = #X=>\\x:X=>x";
    const program = parseTripLang(input);
    const result = unparseTerm(
      requiredAt(program.terms, 1, "expected poly definition"),
    );
    assert.equal(result, "poly id = #X=>\\x:X=>x");
  });

  await t.test("should unparse a poly definition with match", () => {
    const input =
      "module Test\ndata Maybe = None | Some T\npoly test = match x [Maybe] { | None => y | Some a => a }";
    const program = parseTripLang(input);
    const matchTerm = requiredAt(program.terms, 2, "expected match definition");
    const result = unparseTerm(matchTerm);
    assert.include(result, "test");
    assert.include(result, "match");
  });

  await t.test("should unparse a data definition", () => {
    const input = "module Test\ndata Maybe = None | Some T";
    const program = parseTripLang(input);
    const dataTerm = requiredAt(program.terms, 1, "expected data definition");
    const result = unparseTerm(dataTerm);
    assert.equal(result, "data Maybe = None | Some T");
  });

  await t.test("should unparse an internal lambda definition", () => {
    const result = unparseTerm({
      kind: "lambda",
      name: "id",
      term: mkUntypedAbs("x", mkVar("x")),
    });
    assert.equal(result, "lambda id = \\x=>x");
  });

  await t.test("should unparse a combinator definition", () => {
    const input = "module Test\ncombinator id = I";
    const program = parseTripLang(input);
    const result = unparseTerm(
      requiredAt(program.terms, 1, "expected combinator definition"),
    );
    assert.equal(result, "combinator id = I");
  });

  await t.test("should unparse a type definition", () => {
    const input = "module Test\ntype MyType = A->B";
    const program = parseTripLang(input);
    const result = unparseTerm(
      requiredAt(program.terms, 1, "expected type definition"),
    );
    assert.equal(result, "type MyType = (A->B)");
  });

  await t.test("should unparse a native definition", () => {
    const input = "module Test\nnative eqU8 : U8 -> U8 -> Bool";
    const program = parseTripLang(input);
    const nativeTerm = program.terms.find((d) => d.kind === "native");
    assert.ok(nativeTerm !== undefined, "expected native definition");
    const result = unparseTerm(nativeTerm);
    assert.include(result, "native");
    assert.include(result, "eqU8");
    assert.include(result, "U8");
    assert.include(result, "Bool");
  });

  await t.test("should unparse module definition", () => {
    const input = "module Test";
    const program = parseTripLang(input);
    const result = unparseTerm(
      requiredAt(program.terms, 0, "expected module definition"),
    );
    assert.equal(result, "module Test");
  });

  await t.test("should unparse import definition", () => {
    const input = "module Test\nimport Foo bar";
    const program = parseTripLang(input);
    const result = unparseTerm(
      requiredAt(program.terms, 1, "expected import definition"),
    );
    assert.equal(result, "import Foo bar");
  });

  await t.test("should unparse export definition", () => {
    const input = "module Test\nexport Foo";
    const program = parseTripLang(input);
    const result = unparseTerm(
      requiredAt(program.terms, 1, "expected export definition"),
    );
    assert.equal(result, "export Foo");
  });

  await t.test("should round-trip a program through canonical unparse", () => {
    const input = `module Test
import Foo bar
export main
poly rec main : #A->A = #A=>bar[A]`;
    const program = parseTripLang(input);
    const canonical = unparseProgram(program);
    assert.include(canonical, "import Foo bar");
    assert.include(canonical, "poly rec main : #A->A =");
    assert.equal(unparseProgram(parseTripLang(canonical)), canonical);
  });
});

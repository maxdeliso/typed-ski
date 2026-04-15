import { describe, it } from "../../util/test_shim.ts";
import assert from "node:assert/strict";
import {
  unparseProgram,
  unparseTerm,
} from "../../../lib/meta/frontend/unparse.ts";
import { parseTripLang } from "../../../lib/parser/tripLang.ts";
import { requiredAt } from "../../util/required.ts";

describe("unparseTerm", () => {
  it("should unparse a poly definition", () => {
    const input = "module Test\npoly id = #X=>\\x:X=>x";
    const program = parseTripLang(input);
    const result = unparseTerm(
      requiredAt(program.terms, 1, "expected poly definition"),
    );
    assert.equal(result, "poly id = #X=>\\x:X=>x");
  });

  it("should unparse a poly definition with match", () => {
    const input =
      "module Test\ndata Maybe = None | Some T\npoly test = match x [Maybe] { | None => y | Some a => a }";
    const program = parseTripLang(input);
    const matchTerm = requiredAt(program.terms, 2, "expected match definition");
    const result = unparseTerm(matchTerm);
    assert.ok(result.includes("test"));
    assert.ok(result.includes("match"));
  });

  it("should unparse a data definition", () => {
    const input = "module Test\ndata Maybe = None | Some T";
    const program = parseTripLang(input);
    const dataTerm = requiredAt(program.terms, 1, "expected data definition");
    const result = unparseTerm(dataTerm);
    assert.equal(result, "data Maybe = None | Some T");
  });

  it("should unparse a combinator definition", () => {
    const input = "module Test\ncombinator id = I";
    const program = parseTripLang(input);
    const result = unparseTerm(
      requiredAt(program.terms, 1, "expected combinator definition"),
    );
    assert.equal(result, "combinator id = I");
  });

  it("should unparse a type definition", () => {
    const input = "module Test\ntype MyType = A->B";
    const program = parseTripLang(input);
    const result = unparseTerm(
      requiredAt(program.terms, 1, "expected type definition"),
    );
    assert.equal(result, "type MyType = (A->B)");
  });

  it("should unparse a native definition", () => {
    const input = "module Test\nnative eqU8 : U8 -> U8 -> Bool";
    const program = parseTripLang(input);
    const nativeTerm = program.terms.find((d) => d.kind === "native");
    assert.ok(nativeTerm !== undefined, "expected native definition");
    const result = unparseTerm(nativeTerm);
    assert.ok(result.includes("native"));
    assert.ok(result.includes("eqU8"));
    assert.ok(result.includes("U8"));
    assert.ok(result.includes("Bool"));
  });

  it("should unparse module definition", () => {
    const input = "module Test";
    const program = parseTripLang(input);
    const result = unparseTerm(
      requiredAt(program.terms, 0, "expected module definition"),
    );
    assert.equal(result, "module Test");
  });

  it("should unparse import definition", () => {
    const input = "module Test\nimport Foo bar";
    const program = parseTripLang(input);
    const result = unparseTerm(
      requiredAt(program.terms, 1, "expected import definition"),
    );
    assert.equal(result, "import Foo bar");
  });

  it("should unparse export definition", () => {
    const input = "module Test\nexport Foo";
    const program = parseTripLang(input);
    const result = unparseTerm(
      requiredAt(program.terms, 1, "expected export definition"),
    );
    assert.equal(result, "export Foo");
  });

  it("should round-trip a program through canonical unparse", () => {
    const input = `module Test
import Foo bar
export main
poly rec main : #A->A = #A=>bar[A]`;
    const program = parseTripLang(input);
    const canonical = unparseProgram(program);
    assert.ok(canonical.includes("import Foo bar"));
    assert.ok(canonical.includes("poly rec main : #A->A ="));
    assert.equal(unparseProgram(parseTripLang(canonical)), canonical);
  });
});

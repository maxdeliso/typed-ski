import { assert } from "chai";
import { unparseTerm } from "../../../lib/meta/frontend/unparse.ts";
import { parseTripLang } from "../../../lib/parser/tripLang.ts";

Deno.test("unparseTerm", async (t) => {
  await t.step("should unparse a poly definition", () => {
    const input = "module Test\npoly id = #X=>\\x:X=>x";
    const program = parseTripLang(input);
    const result = unparseTerm(program.terms[1]);
    assert.include(result, "id");
    assert.include(result, "#X=>");
  });

  await t.step("should unparse a poly definition with match", () => {
    const input =
      "module Test\ndata Maybe = None | Some T\npoly test = match x [Maybe] { | None => y | Some a => a }";
    const program = parseTripLang(input);
    const matchTerm = program.terms[2];
    const result = unparseTerm(matchTerm);
    assert.include(result, "test");
    assert.include(result, "match");
  });

  await t.step("should unparse a data definition", () => {
    const input = "module Test\ndata Maybe = None | Some T";
    const program = parseTripLang(input);
    const dataTerm = program.terms[1];
    const result = unparseTerm(dataTerm);
    assert.include(result, "data Maybe");
    assert.include(result, "None");
    assert.include(result, "Some");
  });

  await t.step("should unparse a typed definition", () => {
    const input = "module Test\ntyped id = \\x:A=>x";
    const program = parseTripLang(input);
    const result = unparseTerm(program.terms[1]);
    assert.include(result, "id");
    assert.include(result, "\\x:A=>");
  });

  await t.step("should unparse an untyped definition", () => {
    const input = "module Test\nuntyped id = \\x=>x";
    const program = parseTripLang(input);
    const result = unparseTerm(program.terms[1]);
    assert.include(result, "id");
    assert.include(result, "\\x=>");
  });

  await t.step("should unparse a combinator definition", () => {
    const input = "module Test\ncombinator id = I";
    const program = parseTripLang(input);
    const result = unparseTerm(program.terms[1]);
    assert.include(result, "id");
    assert.include(result, "I");
  });

  await t.step("should unparse a type definition", () => {
    const input = "module Test\ntype MyType = A->B";
    const program = parseTripLang(input);
    const result = unparseTerm(program.terms[1]);
    assert.include(result, "MyType");
    assert.include(result, "A->B");
  });

  await t.step("should unparse module definition", () => {
    const input = "module Test";
    const program = parseTripLang(input);
    const result = unparseTerm(program.terms[0]);
    assert.equal(result, "module Test");
  });

  await t.step("should unparse import definition", () => {
    const input = "module Test\nimport Foo bar";
    const program = parseTripLang(input);
    const result = unparseTerm(program.terms[1]);
    assert.equal(result, "import bar from Foo");
  });

  await t.step("should unparse export definition", () => {
    const input = "module Test\nexport Foo";
    const program = parseTripLang(input);
    const result = unparseTerm(program.terms[1]);
    assert.equal(result, "export Foo");
  });
});

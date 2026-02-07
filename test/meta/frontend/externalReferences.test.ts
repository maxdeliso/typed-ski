import { assert } from "chai";
import {
  externalReferences,
  extractDefinitionValue,
  parseTripLang,
} from "../../../lib/index.ts";
import { required, requiredAt } from "../../util/required.ts";

function getFirstDefinitionValue(input: string) {
  const program = parseTripLang(input);
  const firstTerm = requiredAt(program.terms, 0, "expected first term");
  return required(
    extractDefinitionValue(firstTerm),
    "expected first term to have a definition value",
  );
}

Deno.test("externalReferences", async (t) => {
  await t.step(
    "identifies external references in a simple lambda abstraction",
    () => {
      const input = "poly id = \\x:A=>x";
      const [termRefs, typeRefs] = externalReferences(
        getFirstDefinitionValue(input),
      );

      assert.deepStrictEqual(Array.from(termRefs.keys()), []);
      assert.deepStrictEqual(Array.from(typeRefs.keys()), [
        "A",
      ]);
    },
  );

  await t.step("identifies external references in a System F term", () => {
    const input = "poly id = #X=>\\x:X=>x";
    const [termRefs, typeRefs] = externalReferences(
      getFirstDefinitionValue(input),
    );

    assert.deepStrictEqual(Array.from(termRefs.keys()), []);
    assert.deepStrictEqual(Array.from(typeRefs.keys()), []);
  });

  await t.step(
    "identifies external references in a term with free variables",
    () => {
      const input = "poly free = \\x:A=>y";
      const [termRefs, typeRefs] = externalReferences(
        getFirstDefinitionValue(input),
      );

      assert.deepStrictEqual(Array.from(termRefs.keys()), [
        "y",
      ]);
      assert.deepStrictEqual(Array.from(typeRefs.keys()), [
        "A",
      ]);
    },
  );

  await t.step(
    "identifies external references in a System F term with free type variables",
    () => {
      const input = "poly freeType = #X=>\\x:Y=>x";
      const [termRefs, typeRefs] = externalReferences(
        getFirstDefinitionValue(input),
      );

      assert.deepStrictEqual(Array.from(termRefs.keys()), []);
      assert.deepStrictEqual(Array.from(typeRefs.keys()), [
        "Y",
      ]);
    },
  );

  await t.step("identifies external references in a complex term", () => {
    const input = "poly complex = \\x:A=>\\y:B=>(x (y z))";
    const [termRefs, typeRefs] = externalReferences(
      getFirstDefinitionValue(input),
    );

    assert.deepStrictEqual(Array.from(termRefs.keys()).sort(), ["z"]);
    assert.deepStrictEqual(Array.from(typeRefs.keys()).sort(), [
      "A",
      "B",
    ]);
  });

  await t.step(
    "identifies external references in a System F term with type application",
    () => {
      const input = "poly typeApp = #X=>\\x:X=>(x[Y])";
      const [termRefs, typeRefs] = externalReferences(
        getFirstDefinitionValue(input),
      );

      assert.deepStrictEqual(Array.from(termRefs.keys()), []);
      assert.deepStrictEqual(Array.from(typeRefs.keys()), [
        "Y",
      ]);
    },
  );

  await t.step("identifies external references in a non-terminal term", () => {
    const input = "poly app = (x y)";
    const [termRefs, typeRefs] = externalReferences(
      getFirstDefinitionValue(input),
    );

    assert.deepStrictEqual(Array.from(termRefs.keys()).sort(), [
      "x",
      "y",
    ]);
    assert.deepStrictEqual(Array.from(typeRefs.keys()), []);
  });

  await t.step(
    "identifies external references in a term with nested abstractions",
    () => {
      const input = "poly nested = \\x:A=>\\y:B=>(\\z:C=>(x y z))";
      const [termRefs, typeRefs] = externalReferences(
        getFirstDefinitionValue(input),
      );

      assert.deepStrictEqual(Array.from(termRefs.keys()).sort(), []);
      assert.deepStrictEqual(Array.from(typeRefs.keys()).sort(), [
        "A",
        "B",
        "C",
      ]);
    },
  );

  await t.step(
    "identifies external references in a System F match expression",
    () => {
      const input =
        "poly matchTest = match x [T] { | Cons a b => (a y) | None => z }";
      const [termRefs, typeRefs] = externalReferences(
        getFirstDefinitionValue(input),
      );

      // x, y, z are external; a and b are bound by match arm
      assert.deepStrictEqual(Array.from(termRefs.keys()).sort(), [
        "x",
        "y",
        "z",
      ]);
      assert.deepStrictEqual(Array.from(typeRefs.keys()).sort(), ["T"]);
    },
  );

  await t.step(
    "identifies external references in a System F match with nested match",
    () => {
      const input =
        "poly nestedMatch = match x [T] { | Some a => match a [U] { | Cons b c => (b w) } }";
      const [termRefs, typeRefs] = externalReferences(
        getFirstDefinitionValue(input),
      );

      // x, w are external; a, b, c are bound by match arms
      assert.deepStrictEqual(Array.from(termRefs.keys()).sort(), [
        "w",
        "x",
      ]);
      assert.deepStrictEqual(Array.from(typeRefs.keys()).sort(), [
        "T",
        "U",
      ]);
    },
  );
});

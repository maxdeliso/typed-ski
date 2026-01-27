import { assert } from "chai";
import {
  externalReferences,
  extractDefinitionValue,
  parseTripLang,
} from "../../../lib/index.ts";

Deno.test("externalReferences", async (t) => {
  await t.step(
    "identifies external references in a simple lambda abstraction",
    () => {
      const input = "poly id = \\x:A=>x";
      const program = parseTripLang(input);
      const [termRefs, typeRefs] = externalReferences(
        extractDefinitionValue(program.terms[0])!,
      );

      assert.deepStrictEqual(Array.from(termRefs.keys()), []);
      assert.deepStrictEqual(Array.from(typeRefs.keys()), [
        "A",
      ]);
    },
  );

  await t.step("identifies external references in a System F term", () => {
    const input = "poly id = #X=>\\x:X=>x";
    const program = parseTripLang(input);
    const [termRefs, typeRefs] = externalReferences(
      extractDefinitionValue(program.terms[0])!,
    );

    assert.deepStrictEqual(Array.from(termRefs.keys()), []);
    assert.deepStrictEqual(Array.from(typeRefs.keys()), []);
  });

  await t.step(
    "identifies external references in a term with free variables",
    () => {
      const input = "poly free = \\x:A=>y";
      const program = parseTripLang(input);
      const [termRefs, typeRefs] = externalReferences(
        extractDefinitionValue(program.terms[0])!,
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
      const program = parseTripLang(input);
      const [termRefs, typeRefs] = externalReferences(
        extractDefinitionValue(program.terms[0])!,
      );

      assert.deepStrictEqual(Array.from(termRefs.keys()), []);
      assert.deepStrictEqual(Array.from(typeRefs.keys()), [
        "Y",
      ]);
    },
  );

  await t.step("identifies external references in a complex term", () => {
    const input = "poly complex = \\x:A=>\\y:B=>(x (y z))";
    const program = parseTripLang(input);
    const [termRefs, typeRefs] = externalReferences(
      extractDefinitionValue(program.terms[0])!,
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
      const program = parseTripLang(input);
      const [termRefs, typeRefs] = externalReferences(
        extractDefinitionValue(program.terms[0])!,
      );

      assert.deepStrictEqual(Array.from(termRefs.keys()), []);
      assert.deepStrictEqual(Array.from(typeRefs.keys()), [
        "Y",
      ]);
    },
  );

  await t.step("identifies external references in a non-terminal term", () => {
    const input = "poly app = (x y)";
    const program = parseTripLang(input);
    const [termRefs, typeRefs] = externalReferences(
      extractDefinitionValue(program.terms[0])!,
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
      const program = parseTripLang(input);
      const [termRefs, typeRefs] = externalReferences(
        extractDefinitionValue(program.terms[0])!,
      );

      assert.deepStrictEqual(Array.from(termRefs.keys()).sort(), []);
      assert.deepStrictEqual(Array.from(typeRefs.keys()).sort(), [
        "A",
        "B",
        "C",
      ]);
    },
  );
});

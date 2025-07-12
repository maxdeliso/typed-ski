import { assert } from "npm:chai";

import { dirname, fromFileUrl, join } from "https://deno.land/std/path/mod.ts";
import { loadInput } from "../util/fileLoader.ts";

import {
  bracketLambda,
  compile,
  eraseSystemF,
  eraseTypedLambda,
  externalReferences,
  indexSymbols,
  parseSystemF,
  parseTripLang,
  prettyPrintSystemF,
  prettyPrintTy,
  resolveExternalProgramReferences,
  searchAVL,
  symbolicEvaluator,
  type SystemFTerm,
  type TripLangTerm,
  UnChurchNumber,
} from "../../lib/index.ts";

import { type AVLTree, keyValuePairs } from "../../lib/data/avl/avlNode.ts";
import { compareStrings } from "../../lib/data/map/stringMap.ts";
import type { BaseType } from "../../lib/types/types.ts";
import { initArenaEvaluator } from "../../lib/evaluator/arenaEvaluator.ts";

import {
  resolvePoly,
  resolveUntyped,
} from "../../lib/meta/frontend/compilation.ts";

const __dirname = dirname(fromFileUrl(import.meta.url));
const wasmPath = join(__dirname, "../../assembly/build/debug.wasm");

const arenaEval = await initArenaEvaluator(wasmPath);

function isSystemFTerm(term: unknown): term is SystemFTerm {
  return !!term && typeof term === "object" &&
    [
      "systemF-var",
      "systemF-abs",
      "systemF-type-abs",
      "systemF-type-app",
      "non-terminal",
    ]
      .includes((term as { kind?: string }).kind ?? "");
}

function assertSystemFTermMatches(
  actual: SystemFTerm,
  src: string,
  msg?: string,
) {
  const [, expected] = parseSystemF(src);
  assert.deepEqual(actual, expected, msg ?? "SystemF ASTs differ");
}

function assertTermMatches(actual: unknown, expectedSrc: string, msg?: string) {
  if (isSystemFTerm(actual)) {
    assertSystemFTermMatches(actual, expectedSrc, msg);
  } else {
    assert.strictEqual(actual, expectedSrc, msg);
  }
}

function assertTypeDefinition(
  types: AVLTree<string, BaseType>,
  id: string,
  expected: string,
) {
  const ty = searchAVL(types, id, compareStrings);
  assert.isDefined(ty, `${id} should be defined`);
  assert.strictEqual(prettyPrintTy(ty!), expected);
}

Deno.test("TripLang → System F compiler integration", async (t) => {
  await t.step("executes condSucc example", () => {
    const src = loadInput("condSucc.trip", __dirname);
    const compiled = compile(src);
    const mainPoly = resolvePoly(compiled, "main");
    const skiMain = bracketLambda(
      eraseTypedLambda(eraseSystemF(mainPoly.term)),
    );
    const nf = arenaEval.reduce(skiMain);
    assert.equal(UnChurchNumber(nf), 3);
  });

  await t.step("parses & runs pred example", () => {
    const src = loadInput("pred.trip", __dirname);
    const compiled = compile(src);

    const num = (name: string) => {
      const termPoly = compiled.program.terms.find(
        (d) => d.kind === "poly" && d.name === name,
      ) as { kind: "poly"; term: SystemFTerm };
      const ski = bracketLambda(eraseTypedLambda(eraseSystemF(termPoly.term)));
      return UnChurchNumber(arenaEval.reduce(ski));
    };

    assert.equal(num("testPred1"), 0);
    assert.equal(num("testPred3"), 2);
    assert.equal(num("testFst"), 2);
    assert.equal(num("testSnd"), 3);
    assert.equal(num("main"), 3);
  });

  await t.step("compiles mul example (six & twenty-four)", () => {
    const src = loadInput("mul.trip", __dirname);
    const compiled = compile(src);

    const sixPoly = resolvePoly(compiled, "six");

    const skiSix = bracketLambda(
      eraseTypedLambda(eraseSystemF(
        sixPoly.term,
      )),
    );

    const twentyFourPoly = resolvePoly(compiled, "twentyFour");
    const ski24 = bracketLambda(
      eraseTypedLambda(eraseSystemF(
        twentyFourPoly.term,
      )),
    );

    assert.equal(UnChurchNumber(arenaEval.reduce(skiSix)), 6);
    assert.equal(UnChurchNumber(arenaEval.reduce(ski24)), 24);
  });

  await t.step("loads factorial with fixpoint", () => {
    const src = loadInput("fixFact.trip", __dirname);
    const program = parseTripLang(src);

    const factKernel = program.terms.find(
      (d) => d.kind === "poly" && d.name === "factKernel",
    ) as { kind: "poly"; term: SystemFTerm };
    const [termRefs, typeRefs] = externalReferences(factKernel.term);

    assert.deepEqual(
      keyValuePairs(termRefs).map(([k]) => k).sort(),
      ["cond", "isZero", "mul", "one", "pred"].sort(),
    );
    assert.deepEqual(
      keyValuePairs(typeRefs).map(([k]) => k).sort(),
      ["Nat"],
    );

    const compiled = compile(src);
    const mainUntyped = resolveUntyped(compiled, "main");
    const mainSki = bracketLambda(mainUntyped.term);
    assert.equal(UnChurchNumber(arenaEval.reduce(mainSki)), 120);
  });

  await t.step("elaborates nested type applications", () => {
    const src = loadInput("nestedTypeApps.trip", __dirname);
    const program = parseTripLang(src);
    const succRaw = program.terms.find((d) =>
      d.kind === "poly" && d.name === "succ"
    )!;

    assertTermMatches(
      prettyPrintSystemF((succRaw as { kind: "poly"; term: SystemFTerm }).term),
      "λn:Nat.ΛX.λs:(X→X).λz:X.(s (n[X] s z))",
    );

    const resolved = resolveExternalProgramReferences(
      program,
      indexSymbols(program),
    );
    const succRes = resolved.terms.find((d: TripLangTerm) =>
      d.kind === "poly" && d.name === "succ"
    )!;
    assertTermMatches(
      prettyPrintSystemF((succRes as { kind: "poly"; term: SystemFTerm }).term),
      "λn:∀X.((X→X)→(X→X)).ΛX.λs:(X→X).λz:X.(s (n[X] s z))",
    );
  });

  await t.step("compiles + evaluates full polymorphic factorial", () => {
    const src = loadInput("polyFact.trip", __dirname);
    const compiled = compile(src);

    // expect 9 type definitions, with specific ids
    const ids = keyValuePairs(compiled.types).map(([id]) => id);
    assert.deepEqual(
      ids.sort(),
      [
        "fact",
        "fst",
        "main",
        "mul",
        "one",
        "pair",
        "snd",
        "succ",
        "zero",
      ].sort(),
    );

    // spot-check a few definitions
    assertTypeDefinition(compiled.types, "zero", "∀X.((X→X)→(X→X))");
    assertTypeDefinition(
      compiled.types,
      "fact",
      "(∀X.((X→X)→(X→X))→∀X.((X→X)→(X→X)))",
    );
    const mainPoly = resolvePoly(compiled, "main");
    const mainRes = symbolicEvaluator.reduce(
      bracketLambda(eraseTypedLambda(eraseSystemF(mainPoly.term))),
    );
    assert.equal(UnChurchNumber(mainRes), 24);
  });
});

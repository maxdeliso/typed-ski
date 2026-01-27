import { assert } from "chai";

import { dirname, fromFileUrl } from "std/path";
import { loadInput } from "../util/fileLoader.ts";

const __dirname = dirname(fromFileUrl(import.meta.url));

import {
  bracketLambda,
  compile,
  eraseSystemF,
  externalReferences,
  indexSymbols,
  parseSystemF,
  parseTripLang,
  resolveExternalProgramReferences,
  type SystemFTerm,
  type TripLangTerm,
  UnChurchNumber,
  unparseSystemF,
  unparseType,
} from "../../lib/index.ts";

import type { BaseType } from "../../lib/types/types.ts";
import { ParallelArenaEvaluatorWasm } from "../../lib/evaluator/parallelArenaEvaluator.ts";

import {
  resolvePoly,
  resolveUntyped,
} from "../../lib/meta/frontend/compilation.ts";
import { elaborateTerms } from "../../lib/meta/frontend/elaboration.ts";

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
  types: Map<string, BaseType>,
  id: string,
  expected: string,
) {
  const ty = types.get(id);
  assert.isDefined(ty, `${id} should be defined`);
  assert.strictEqual(unparseType(ty!), expected);
}

Deno.test("TripLang → System F compiler integration", async (t) => {
  // Use the parallel WASM arena reducer (worker pool) in this suite.
  // Important: terminate it at the end to avoid Deno leak detection (workers/timers).
  const arenaEval = await ParallelArenaEvaluatorWasm.create(2);
  try {
    await t.step("executes condSucc example", async () => {
      const src = loadInput("condSucc.trip", __dirname);
      const compiled = compile(src);
      const mainPoly = resolvePoly(compiled, "main");
      const skiMain = bracketLambda(
        eraseSystemF(mainPoly.term),
      );
      const nf = await arenaEval.reduceAsync(skiMain);
      assert.equal(UnChurchNumber(nf), 3n);
    });

    await t.step("Result data type with match expression", async () => {
      const src = loadInput("resultMatch.trip", __dirname);
      const compiled = compile(src);

      const num = async (name: string) => {
        const termPoly = compiled.program.terms.find(
          (d) => d.kind === "poly" && d.name === name,
        ) as { kind: "poly"; term: SystemFTerm };
        const ski = bracketLambda(eraseSystemF(termPoly.term));
        return UnChurchNumber(await arenaEval.reduceAsync(ski));
      };

      // testOk should return 2 (the value from Ok two)
      assert.equal(await num("testOk"), 2n);
      // testErr should return 0 (the default value)
      assert.equal(await num("testErr"), 0n);
      // main should return 2 (same as testOk)
      assert.equal(await num("main"), 2n);
    });

    await t.step("parses & runs pred example", async () => {
      const src = loadInput("pred.trip", __dirname);
      const compiled = compile(src);

      const num = async (name: string) => {
        const termPoly = compiled.program.terms.find(
          (d) => d.kind === "poly" && d.name === name,
        ) as { kind: "poly"; term: SystemFTerm };
        const ski = bracketLambda(eraseSystemF(termPoly.term));
        return UnChurchNumber(await arenaEval.reduceAsync(ski));
      };

      assert.equal(await num("testPred1"), 0n);
      assert.equal(await num("testPred3"), 2n);
      assert.equal(await num("testFst"), 2n);
      assert.equal(await num("testSnd"), 3n);
      assert.equal(await num("main"), 3n);
    });

    await t.step("compiles mul example (six & twenty-four)", async () => {
      const src = loadInput("mul.trip", __dirname);
      const compiled = compile(src);

      const sixPoly = resolvePoly(compiled, "six");

      const skiSix = bracketLambda(
        eraseSystemF(sixPoly.term),
      );

      const twentyFourPoly = resolvePoly(compiled, "twentyFour");
      const ski24 = bracketLambda(
        eraseSystemF(twentyFourPoly.term),
      );

      assert.equal(UnChurchNumber(await arenaEval.reduceAsync(skiSix)), 6n);
      assert.equal(UnChurchNumber(await arenaEval.reduceAsync(ski24)), 24n);
    });

    await t.step("loads factorial with fixpoint", async () => {
      const src = loadInput("fixFact.trip", __dirname);
      const program = parseTripLang(src);

      const factKernel = program.terms.find(
        (d) => d.kind === "poly" && d.name === "factKernel",
      ) as { kind: "poly"; term: SystemFTerm };
      const [termRefs, typeRefs] = externalReferences(factKernel.term);

      assert.deepEqual(
        Array.from(termRefs.keys()).sort(),
        ["cond", "isZero", "mul", "one", "pred"].sort(),
      );
      assert.deepEqual(
        Array.from(typeRefs.keys()).sort(),
        ["Nat"],
      );

      const compiled = compile(src);
      const mainUntyped = resolveUntyped(compiled, "main");
      const mainSki = bracketLambda(mainUntyped.term);
      assert.equal(UnChurchNumber(await arenaEval.reduceAsync(mainSki)), 120n);
    });

    await t.step("loads factorial with poly rec syntax", async () => {
      const src = loadInput("recFact.trip", __dirname);
      const program = parseTripLang(src);

      const factDef = program.terms.find(
        (d) => d.kind === "poly" && d.name === "fact",
      ) as { kind: "poly"; term: SystemFTerm };
      const [termRefs, typeRefs] = externalReferences(factDef.term);

      assert.deepEqual(
        Array.from(termRefs.keys()).sort(),
        ["cond", "fact", "isZero", "mul", "one", "pred"].sort(),
      );
      assert.deepEqual(
        Array.from(typeRefs.keys()).sort(),
        ["Nat"],
      );

      const compiled = compile(src);
      const mainUntyped = resolveUntyped(compiled, "main");
      const mainSki = bracketLambda(mainUntyped.term);
      assert.equal(UnChurchNumber(await arenaEval.reduceAsync(mainSki)), 120n);
    });

    await t.step("evaluates Maybe ADT constructors", async () => {
      const src = loadInput("adtMaybe.trip", __dirname);
      const compiled = compile(src);
      const mainPoly = resolvePoly(compiled, "main");
      const mainSki = bracketLambda(eraseSystemF(mainPoly.term));
      assert.equal(UnChurchNumber(await arenaEval.reduceAsync(mainSki)), 2n);
    });

    await t.step("evaluates Result ADT constructors", async () => {
      const src = loadInput("adtResult.trip", __dirname);
      const compiled = compile(src);
      const mainPoly = resolvePoly(compiled, "main");
      const mainSki = bracketLambda(eraseSystemF(mainPoly.term));
      assert.equal(UnChurchNumber(await arenaEval.reduceAsync(mainSki)), 2n);
    });

    await t.step("elaborates nested type applications", () => {
      const src = loadInput("nestedTypeApps.trip", __dirname);
      const program = parseTripLang(src);
      const succRaw = program.terms.find((d) =>
        d.kind === "poly" && d.name === "succ"
      )!;

      assertTermMatches(
        unparseSystemF(
          (succRaw as { kind: "poly"; term: SystemFTerm }).term,
        ),
        "\\n:Nat=>#X=>\\s:(X->X)=>\\z:X=>(s (n[X] s z))",
      );

      const resolved = resolveExternalProgramReferences(
        program,
        indexSymbols(program),
      );
      const succRes = resolved.terms.find((d: TripLangTerm) =>
        d.kind === "poly" && d.name === "succ"
      )!;
      assertTermMatches(
        unparseSystemF(
          (succRes as { kind: "poly"; term: SystemFTerm }).term,
        ),
        "\\n:#X->((X->X)->(X->X))=>#X=>\\s:(X->X)=>\\z:X=>(s (n[X] s z))",
      );
    });

    await t.step(
      "compiles + evaluates full polymorphic factorial",
      async () => {
        const src = loadInput("polyFact.trip", __dirname);
        const compiled = compile(src);

        // expect 9 type definitions, with specific ids
        const ids = Array.from(compiled.types.keys());
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
        assertTypeDefinition(
          compiled.types,
          "zero",
          "#X->((X->X)->(X->X))",
        );
        assertTypeDefinition(
          compiled.types,
          "fact",
          "(#X->((X->X)->(X->X))->#X->((X->X)->(X->X)))",
        );
        const mainPoly = resolvePoly(compiled, "main");
        const mainRes = await arenaEval.reduceAsync(
          bracketLambda(eraseSystemF(mainPoly.term)),
        );
        assert.equal(UnChurchNumber(mainRes), 24n);
      },
    );

    await t.step("expands data definitions into constructors", () => {
      const src = `module DataMaybe
data Maybe A = Nothing | Just A`;
      const compiled = compile(src);
      const terms = compiled.program.terms;

      assert.deepEqual(terms[0], { kind: "module", name: "DataMaybe" });

      const maybeType = terms.find((term) =>
        term.kind === "type" && term.name === "Maybe"
      );
      assert.isDefined(maybeType);
      assert.strictEqual(
        unparseType((maybeType as { type: BaseType }).type),
        "#A->#R->(R->((A->R)->R))",
      );

      const ctorNames = terms
        .filter((term) => term.kind === "poly")
        .map((term) => term.name)
        .sort();
      assert.deepEqual(ctorNames, ["Just", "Nothing"]);
    });

    await t.step("desugars match arms in constructor order", () => {
      const src = `module MatchBool
data Bool = False | True
poly flip = match True [Bool] { | True => False | False => True }`;
      const program = parseTripLang(src);
      const syms = indexSymbols(program);
      const elaborated = elaborateTerms(program, syms);
      const flip = elaborated.terms.find((term) =>
        term.kind === "poly" && term.name === "flip"
      );
      assert.isDefined(flip);
      assert.strictEqual(
        unparseSystemF((flip as { term: SystemFTerm }).term),
        "(True[Bool] True False)",
      );
    });

    await t.step("evaluates match with both alternatives", async () => {
      const src = `module MatchBoolEval
type Nat = #X -> (X -> X) -> X -> X
poly zero = #X => \\s : X -> X => \\z : X => z
poly succ = \\n : Nat => #a => \\s : a -> a => \\z : a => s (n [a] s z)
poly one = succ zero
data Bool = False | True
poly mainTrue = match True [Nat] { | True => one | False => zero }
poly mainFalse = match False [Nat] { | True => one | False => zero }`;
      const compiled = compile(src);

      const mainTrue = resolvePoly(compiled, "mainTrue");
      const trueRes = await arenaEval.reduceAsync(
        bracketLambda(eraseSystemF(mainTrue.term)),
      );
      assert.equal(UnChurchNumber(trueRes), 1n);

      const mainFalse = resolvePoly(compiled, "mainFalse");
      const falseRes = await arenaEval.reduceAsync(
        bracketLambda(eraseSystemF(mainFalse.term)),
      );
      assert.equal(UnChurchNumber(falseRes), 0n);
    });

    await t.step("rejects non-exhaustive match", () => {
      const src = `module MatchNonExhaustive
data Bool = False | True
poly main = match True [Bool] { | True => False }`;
      assert.throws(
        () => compile(src),
        /match is missing constructors: False/,
      );
    });
  } finally {
    arenaEval.terminate();
    // Give the poller loop a chance to observe `aborted` after any pending backoff sleep.
    await new Promise<void>((r) => setTimeout(r, 5));
  }
});

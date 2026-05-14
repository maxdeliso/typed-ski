import { before, after, describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../../lib/meta/frontend/compilation.ts";
import { compileToCombinatorString } from "../../lib/compiler/combinatorCompiler.ts";
import { loadInput } from "../util/fileLoader.ts";
import { unparseType } from "../../lib/parser/type.ts";
import { bracketLambda } from "../../lib/conversion/converter.ts";
import { eraseSystemF } from "../../lib/types/systemF.ts";
import { UnChurchNumber } from "../../lib/ski/church.ts";
import {
  createThanatosEvaluator,
  thanatosAvailable,
  type ThanatosEvaluator,
} from "../../lib/index.ts";
import { type SystemFTerm } from "../../lib/terms/systemF.ts";
import { unparseSystemF } from "../../lib/parser/systemFTerm.ts";
import { parseTripLang } from "../../lib/parser/tripLang.ts";
import { externalReferences } from "../../lib/meta/frontend/externalReferences.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { elaborateTerms } from "../../lib/meta/frontend/elaboration.ts";
import { indexSymbols } from "../../lib/meta/frontend/symbolTable.ts";
import { resolveExternalProgramReferences } from "../../lib/meta/frontend/substitution.ts";
import type { TripLangTerm } from "../../lib/meta/trip.ts";
import type { BaseType } from "../../lib/types/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(__dirname, "../../..");
const srcDir = join(srcRoot, "test", "meta");

function resolvePoly(
  compiled: { program: { terms: TripLangTerm[] } },
  name: string,
): { kind: "poly"; term: SystemFTerm } {
  return compiled.program.terms.find(
    (d) => d.kind === "poly" && d.name === name,
  ) as { kind: "poly"; term: SystemFTerm };
}

function assertTermMatches(actual: string, expected: string) {
  assert.strictEqual(actual.replace(/\s+/g, ""), expected.replace(/\s+/g, ""));
}

function assertTypeDefinition(
  types: Map<string, BaseType>,
  id: string,
  expected: string,
) {
  const ty = types.get(id);
  assert.ok(ty !== undefined && ty !== null, `${id} should be defined`);
  assert.strictEqual(unparseType(ty!), expected);
}

describe(
  "TripLang → System F compiler integration",
  { skip: !thanatosAvailable() },
  () => {
    // Use a Thanatos-backed evaluator and terminate it at the end.
    let arenaEval: ThanatosEvaluator;

    before(async () => {
      arenaEval = await createThanatosEvaluator({ workers: 1 });
    });

    after(async () => {
      if (arenaEval) {
        await arenaEval.terminate();
      }
    });

    it("executes condSucc example", async () => {
      const src = loadInput("condSucc.trip", srcDir);
      const compiled = compile(src);
      const mainPoly = resolvePoly(compiled, "main");
      const skiMain = bracketLambda(eraseSystemF(mainPoly.term));
      const nf = await arenaEval.reduce(skiMain);
      assert.equal(await UnChurchNumber(nf, arenaEval), 3n);
    });

    it("Result data type with match expression", async () => {
      const src = loadInput("resultMatch.trip", srcDir);
      const compiled = compile(src);

      const num = async (name: string) => {
        const termPoly = compiled.program.terms.find(
          (d) => d.kind === "poly" && d.name === name,
        ) as { kind: "poly"; term: SystemFTerm };
        const ski = bracketLambda(eraseSystemF(termPoly.term));
        return await UnChurchNumber(await arenaEval.reduce(ski), arenaEval);
      };

      // testOk should return 2 (the value from Ok two)
      assert.equal(await num("testOk"), 2n);
      // testErr should return 0 (the default value)
      assert.equal(await num("testErr"), 0n);
      // main should return 2 (same as testOk)
      assert.equal(await num("main"), 2n);
    });

    it("parses & runs pred example", async () => {
      const src = loadInput("pred.trip", srcDir);
      const compiled = compile(src);

      const num = async (name: string) => {
        const termPoly = compiled.program.terms.find(
          (d) => d.kind === "poly" && d.name === name,
        ) as { kind: "poly"; term: SystemFTerm };
        const ski = bracketLambda(eraseSystemF(termPoly.term));
        return await UnChurchNumber(await arenaEval.reduce(ski), arenaEval);
      };

      assert.equal(await num("testPred1"), 0n);
      assert.equal(await num("testPred3"), 2n);
      assert.equal(await num("testFst"), 2n);
      assert.equal(await num("testSnd"), 3n);
      assert.equal(await num("main"), 3n);
    });

    it("compiles mul example (six & twenty-four)", async () => {
      const src = loadInput("mul.trip", srcDir);
      const compiled = compile(src);

      const sixPoly = resolvePoly(compiled, "six");

      const skiSix = bracketLambda(eraseSystemF(sixPoly.term));

      const twentyFourPoly = resolvePoly(compiled, "twentyFour");
      const ski24 = bracketLambda(eraseSystemF(twentyFourPoly.term));

      assert.equal(
        await UnChurchNumber(await arenaEval.reduce(skiSix), arenaEval),
        6n,
      );
      assert.equal(
        await UnChurchNumber(await arenaEval.reduce(ski24), arenaEval),
        24n,
      );
    });

    it("loads factorial with poly rec syntax", async () => {
      const src = loadInput("recFact.trip", srcDir);
      const program = parseTripLang(src);

      const factDef = program.terms.find(
        (d) => d.kind === "poly" && d.name === "fact",
      ) as { kind: "poly"; term: SystemFTerm };
      const [termRefs, typeRefs] = externalReferences(factDef.term);

      assert.deepStrictEqual(
        Array.from(termRefs.keys()).sort(),
        ["cond", "fact", "isZero", "mul", "one", "pred"].sort(),
      );
      assert.deepStrictEqual(Array.from(typeRefs.keys()).sort(), ["Nat"]);

      const compiled = compile(src);
      const mains = compiled.program.terms.filter(
        (term) => term.name == "main",
      );
      assert.equal(mains.length, 1);
      const mainSki = parseSKI(
        await compileToCombinatorString(`${src}\nexport main`),
      );

      assert.equal(
        await UnChurchNumber(await arenaEval.reduce(mainSki), arenaEval),
        120n,
      );
    });

    it("evaluates Maybe ADT constructors", async () => {
      const src = loadInput("adtMaybe.trip", srcDir);
      const compiled = compile(src);
      const mainPoly = resolvePoly(compiled, "main");
      const mainSki = bracketLambda(eraseSystemF(mainPoly.term));
      assert.equal(
        await UnChurchNumber(await arenaEval.reduce(mainSki), arenaEval),
        2n,
      );
    });

    it("evaluates Result ADT constructors", async () => {
      const src = loadInput("adtResult.trip", srcDir);
      const compiled = compile(src);
      const mainPoly = resolvePoly(compiled, "main");
      const mainSki = bracketLambda(eraseSystemF(mainPoly.term));
      assert.equal(
        await UnChurchNumber(await arenaEval.reduce(mainSki), arenaEval),
        2n,
      );
    });

    it("elaborates nested type applications", () => {
      const src = loadInput("nestedTypeApps.trip", srcDir);
      const program = parseTripLang(src);
      const succRaw = program.terms.find(
        (d) => d.kind === "poly" && d.name === "succ",
      )!;

      assertTermMatches(
        unparseSystemF((succRaw as { kind: "poly"; term: SystemFTerm }).term),
        "\\n:Nat=>#X=>\\s:(X->X)=>\\z:X=>(s (n[X] s z))",
      );

      const resolved = resolveExternalProgramReferences(
        program,
        indexSymbols(program),
      );
      const succRes = resolved.terms.find(
        (d: TripLangTerm) => d.kind === "poly" && d.name === "succ",
      )!;
      assertTermMatches(
        unparseSystemF((succRes as { kind: "poly"; term: SystemFTerm }).term),
        "\\n:#X->((X->X)->(X->X))=>#X=>\\s:(X->X)=>\\z:X=>(s (n[X] s z))",
      );
    });

    it("compiles + evaluates full polymorphic factorial", async () => {
      const src = loadInput("polyFact.trip", srcDir);
      const compiled = compile(src);

      // expect 9 type definitions, with specific ids
      const ids = Array.from(compiled.types.keys());
      assert.deepStrictEqual(
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
      assertTypeDefinition(compiled.types, "zero", "#X->((X->X)->(X->X))");
      assertTypeDefinition(
        compiled.types,
        "fact",
        "(#X->((X->X)->(X->X))->#X->((X->X)->(X->X)))",
      );
      const mainPoly = resolvePoly(compiled, "main");
      const mainRes = await arenaEval.reduce(
        bracketLambda(eraseSystemF(mainPoly.term)),
      );
      assert.equal(await UnChurchNumber(mainRes, arenaEval), 24n);
    });

    it("expands data definitions into constructors", () => {
      const src = `module DataMaybe
data Maybe A = Nothing | Just A`;
      const compiled = compile(src);
      const terms = compiled.program.terms;

      assert.deepStrictEqual(terms[0], { kind: "module", name: "DataMaybe" });

      const maybeType = terms.find(
        (term) => term.kind === "type" && term.name === "Maybe",
      );
      assert.ok(maybeType !== undefined && maybeType !== null);
      assert.strictEqual(
        unparseType((maybeType as { type: BaseType }).type),
        "#A->#R->(R->((A->R)->R))",
      );

      const ctorNames = terms
        .filter((term) => term.kind === "poly")
        .map((term) => term.name)
        .sort();
      assert.deepStrictEqual(ctorNames, ["Just", "Nothing"]);
    });

    it("desugars match arms in constructor order", () => {
      const src = `module MatchBool
data Bool = False | True
poly flip = match True [Bool] { | True => False | False => True }`;
      const program = parseTripLang(src);
      const syms = indexSymbols(program);
      const elaborated = elaborateTerms(program, syms);
      const flip = elaborated.terms.find(
        (term: any) => term.kind === "poly" && term.name === "flip",
      );
      assert.ok(flip !== undefined && flip !== null);
      assert.strictEqual(
        unparseSystemF((flip as { term: SystemFTerm }).term),
        "(True[Bool] True False)",
      );
    });

    it("evaluates match with both alternatives", async () => {
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
      const trueRes = await arenaEval.reduce(
        bracketLambda(eraseSystemF(mainTrue.term)),
      );
      assert.equal(await UnChurchNumber(trueRes, arenaEval), 1n);

      const mainFalse = resolvePoly(compiled, "mainFalse");
      const falseRes = await arenaEval.reduce(
        bracketLambda(eraseSystemF(mainFalse.term)),
      );
      assert.equal(await UnChurchNumber(falseRes, arenaEval), 0n);
    });

    it("rejects non-exhaustive match", () => {
      const src = `module MatchNonExhaustive
data Bool = False | True
poly main = match True [Bool] { | True => False }`;
      assert.throws(() => compile(src), /match is missing constructors: False/);
    });
  },
);

import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadInput } from '../util/fileLoader.js';
import { assert } from 'chai';
import {
  parseTripLang,
  compile,
  indexSymbols,
  resolveRefs,
  externalReferences,
  eraseSystemF,
  eraseTypedLambda,
  prettyPrintSystemF,
  prettyPrintTy,
  symbolicEvaluator,
  SystemFTerm,
  bracketLambda,
  UnChurchNumber,
  parseSystemF,
  searchAVL
} from '../../lib/index.js';
import { keyValuePairs, AVLTree } from '../../lib/data/avl/avlNode.js';
import { compareStrings } from '../../lib/data/map/stringMap.js';
import { BaseType } from '../../lib/types/types.js';
import { initArenaEvaluator } from '../../lib/evaluator/arenaEvaluator.js';
import path from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
let arenaEval: Awaited<ReturnType<typeof initArenaEvaluator>>;

before(async () => {
  const wasmPath = path.resolve(__dirname, '../../build/debug.wasm');
  arenaEval = await initArenaEvaluator(wasmPath);
});

function isSystemFTerm(term: unknown): term is SystemFTerm {
  return !!term && typeof term === 'object' && typeof (term as { kind?: unknown }).kind === 'string' && (
    (term as { kind?: unknown }).kind === 'systemF-var' ||
    (term as { kind?: unknown }).kind === 'systemF-abs' ||
    (term as { kind?: unknown }).kind === 'systemF-type-abs' ||
    (term as { kind?: unknown }).kind === 'systemF-type-app' ||
    (term as { kind?: unknown }).kind === 'non-terminal'
  );
}

function assertSystemFTermMatches(actual: SystemFTerm, expected: string, message?: string): void {
  try {
    const [, expectedAST] = parseSystemF(expected);
    assert.deepEqual(actual, expectedAST, message ?? 'SystemF ASTs do not match');
  } catch {
    // If ASTs do not match, print pretty-printed terms for debugging
    const actualPretty = prettyPrintSystemF(actual);
    let expectedPretty: string;
    try {
      const [, expectedAST] = parseSystemF(expected);
      expectedPretty = prettyPrintSystemF(expectedAST);
    } catch {
      expectedPretty = expected;
    }
    assert.fail(
      (message ? message + '\n' : '') +
      `SystemF terms do not match symbolically.\nActual:   ${actualPretty}\nExpected: ${expectedPretty}`
    );
  }
}

function assertTypeStringMatches(actual: string, expected: string, message?: string): void {
  assert.equal(actual, expected, message ?? `Expected type ${expected}, got ${actual}`);
}

function assertTermMatches(actual: unknown, expected: string, message?: string): void {
  if (isSystemFTerm(actual)) {
    assertSystemFTermMatches(actual, expected, message);
  } else if (typeof actual === 'string') {
    // Assume it's a type string or untyped lambda string
    assertTypeStringMatches(actual, expected, message);
  } else {
    assert.fail(`Unexpected type for actual: ${typeof actual}`);
  }
}

function assertTypeDefinition(types: AVLTree<string, BaseType>, id: string, expectedType: string): void {
  const type = searchAVL(types, id, compareStrings);
  assert.isDefined(type, `${id} type should be defined`);
  assertTermMatches(prettyPrintTy(type), expectedType);
}

describe('compiler', () => {
  it('runs cond succ', () => {
    const input = loadInput('condSucc.trip', __dirname);
    const compiled = compile(input);
    const mainPoly = compiled.program.terms.find(t => t.kind === 'poly' && t.name === 'main')!;
    assert(mainPoly.kind === 'poly');
    const skiMain  = bracketLambda(eraseTypedLambda(eraseSystemF(mainPoly.term)));
    const nf       = arenaEval.reduce(skiMain);
    const n        = UnChurchNumber(nf);
    assert.equal(n, 3);
  });

  it('parses pred', () => {
    const input = loadInput('pred.trip', __dirname);
    const compiled  = compile(input);

    const num = (name: string) => {
      const term = compiled.program.terms.find(
        t => t.kind === 'poly' && t.name === name) as
        { kind:'poly', term: SystemFTerm };
      const ski = bracketLambda(
        eraseTypedLambda(eraseSystemF(term.term)));
      return UnChurchNumber(arenaEval.reduce(ski));
    };

    assert.equal(num('testPred1'), 0);
    assert.equal(num('testPred3'), 2);
    assert.equal(num('testFst'), 2);
    assert.equal(num('testSnd'), 3);
    assert.equal(num('main'), 3);
  });

  it('parses mul', () => {
    const input = loadInput('mul.trip', __dirname);
    const compiled = compile(input);
    const sixPoly   = compiled.program.terms
      .find(t => t.kind === 'poly' && t.name === 'six')!;
    const twentyFourPoly = compiled.program.terms
      .find(t => t.kind === 'poly' && t.name === 'twentyFour')!;
    assert(sixPoly.kind === 'poly');
    assert(twentyFourPoly.kind === 'poly');

    const skiSix    = bracketLambda(eraseTypedLambda(eraseSystemF(sixPoly.term)));
    const skiTwentyFour  = bracketLambda(eraseTypedLambda(eraseSystemF(twentyFourPoly.term)));
    const six  = UnChurchNumber(arenaEval.reduce(skiSix));
    const twentyFour  = UnChurchNumber(arenaEval.reduce(skiTwentyFour));

    assert.equal(six, 6);
    assert.equal(twentyFour, 24);
  });

  it('loads factorial with fixpoint', () => {
    const input = loadInput('fixFact.trip', __dirname);
    const program = parseTripLang(input);
    assert(program.terms.length === 19);
    const factKernelTerm = program.terms.find(t => t.kind === 'poly' && t.name === 'factKernel');
    assert.isDefined(factKernelTerm, 'factKernel term should be defined');
    assert(factKernelTerm.kind === 'poly');
    const [factKernelTermRefs, factKernelTypeRefs] = externalReferences(factKernelTerm.term);
    const factKernelReferencedTerms = keyValuePairs(factKernelTermRefs).map(kvp => kvp[0]).sort();
    const factKernelReferencedTypes = keyValuePairs(factKernelTypeRefs).map(kvp => kvp[0]).sort();

    const expectedFactKernelTermDeps = ['cond', 'isZero', 'mul', 'one', 'pred'].sort();
    const expectedFactKernelTypeDeps = ['Nat'].sort();

    assert.deepEqual(factKernelReferencedTerms, expectedFactKernelTermDeps, 'factKernel term references should match exactly');
    assert.deepEqual(factKernelReferencedTypes, expectedFactKernelTypeDeps, 'factKernel type references should match exactly');

    const compiled = compile(input);
    const mainTermDef = compiled.program.terms.find(t => t.kind === 'untyped' && t.name === 'main');
    assert.isDefined(mainTermDef, 'main term should be defined');
    assert(mainTermDef.kind === 'untyped', 'main term should be untyped');
    const mainSKI = bracketLambda(mainTermDef.term);

    const currentTerm = mainSKI;
    const reductionResult = arenaEval.reduce(currentTerm);
    const result = UnChurchNumber(reductionResult);
    assert.equal(result, 120);
  });

  it('elaborates nested type applications correctly', () => {
    const input = loadInput('nestedTypeApps.trip', __dirname);
    const program = parseTripLang(input);

    const succTermParsed = program.terms.find(t => t.kind === 'poly' && t.name === 'succ');

    if(succTermParsed!.kind !== 'poly' || !isSystemFTerm(succTermParsed!.term)) {
      throw new Error('Missing succ definition after parse');
    }

    const succParsedPretty = prettyPrintSystemF(succTermParsed!.term);

    assertTermMatches(succParsedPretty, 'λn:Nat.ΛX.λs:(X→X).λz:X.(s (n[X] s z))');

    const syms = indexSymbols(program);
    const resolved = resolveRefs(program, syms);

    const succTermResolved = resolved.terms.find(t => t.kind === 'poly' && t.name === 'succ');

    if(succTermResolved!.kind !== 'poly' || !isSystemFTerm(succTermResolved!.term)) {
      throw new Error('Missing succ resolved definition');
    }

    const succResolvedPretty = prettyPrintSystemF(succTermResolved!.term);

    assertTermMatches(succResolvedPretty, 'λn:∀X.((X→X)→(X→X)).ΛX.λs:(X→X).λz:X.(s (n[X] s z))');
  });

  it('compiles and executes the complete polymorphic factorial program', () => {
    const input = loadInput('polyFact.trip', __dirname);
    const compiled = compile(input);
    const typeCount = keyValuePairs(compiled.types).length;
    assert.equal(typeCount, 9, `Expected 9 types, got ${String(typeCount)}`);

    const types = compiled.types;
    assertTypeDefinition(types, 'zero', '∀X.((X→X)→(X→X))');
    assertTypeDefinition(types, 'succ', '(∀X.((X→X)→(X→X))→∀a.((a→a)→(a→a)))');
    assertTypeDefinition(types, 'pair', '∀A.∀B.(A→(B→∀Y.((A→(B→Y))→Y)))');
    assertTypeDefinition(types, 'fst', '∀A.∀B.(∀Y.((A→(B→Y))→Y)→A)');
    assertTypeDefinition(types, 'snd', '∀A.∀B.(∀Y.((A→(B→Y))→Y)→B)');
    assertTypeDefinition(types, 'mul', '(∀X.((X→X)→(X→X))→(∀X.((X→X)→(X→X))→∀a.((a→a)→(a→a))))');
    assertTypeDefinition(types, 'one', '∀a.((a→a)→(a→a))');
    assertTypeDefinition(types, 'fact', '(∀X.((X→X)→(X→X))→∀X.((X→X)→(X→X)))');
    assertTypeDefinition(types, 'main', '∀X.((X→X)→(X→X))');

    const expectedTypeIds = ['zero', 'succ', 'pair', 'fst', 'snd', 'mul', 'one', 'fact', 'main'];
    for (const [id, ty] of keyValuePairs(compiled.types)) {
      assert.include(expectedTypeIds, id, `Unexpected type ID: ${id} with type ${prettyPrintTy(ty)}`);
    }

    const actualLength = compiled.program.terms.length;
    assert(actualLength == 10, `Expected 10 terms, got ${String(actualLength)}`);
    const last = compiled.program.terms[9];
    const lastKind = last.kind;
    assert(lastKind === 'poly', `Expected kind 'poly', got '${String(lastKind)}'`);

    const mainTerm = last.term;
    const mainSKI = bracketLambda(eraseTypedLambda(eraseSystemF(mainTerm)));
    const factResult = symbolicEvaluator.reduce(mainSKI);
    const result = UnChurchNumber(factResult);
    assert.equal(result, 24, `Expected 24, got ${String(result)}`);
  });
});

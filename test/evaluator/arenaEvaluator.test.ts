import { strict as assert } from 'assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import rsexport, { RandomSeed } from 'random-seed';
const { create } = rsexport;

import { ArenaEvaluatorWasm, initArenaEvaluator }
  from '../../lib/evaluator/arenaEvaluator.js';
import { parseSKI }
  from '../../lib/parser/ski.js';
import { prettyPrint }
  from '../../lib/ski/expression.js';
import { randExpression }
  from '../../lib/ski/generator.js';
import { symbolicEvaluator }
  from '../../lib/evaluator/skiEvaluator.js';

let arenaEval!: ArenaEvaluatorWasm;

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

before(async () => {
  const wasmPath = path.resolve(__dirname, '../../build/debug.wasm');
  arenaEval = await initArenaEvaluator(wasmPath);
});

describe('stepOnce', () => {
  const e1 = parseSKI('III');
  const e2 = parseSKI('II');
  const e3 = parseSKI('I');
  const e4 = parseSKI('KIS');
  const e5 = parseSKI('SKKI');
  const e6 = parseSKI('SKKII');
  const e7 = parseSKI('KI(KI)');

  it(`${prettyPrint(e2)} ⇒ ${prettyPrint(e3)}`, () => {
    const r = arenaEval.stepOnce(e2);
    assert.equal(r.altered, true);
    assert.equal(prettyPrint(r.expr), prettyPrint(e3));
  });

  it(`${prettyPrint(e1)} ⇒ ${prettyPrint(e3)}`, () => {
    const r1 = arenaEval.stepOnce(e1);
    const r2 = arenaEval.stepOnce(r1.expr);

    assert.ok(r1.altered && r2.altered);
    assert.equal(prettyPrint(r2.expr), prettyPrint(e3));
  });

  it(`${prettyPrint(e4)} ⇒ ${prettyPrint(e3)}`, () => {
    const r = arenaEval.stepOnce(e4);
    assert.ok(r.altered);
    assert.equal(prettyPrint(r.expr), prettyPrint(e3));
  });

  it(`${prettyPrint(e5)} ⇒ ${prettyPrint(e7)}`, () => {
    const r = arenaEval.stepOnce(e5);
    assert.ok(r.altered);
    assert.equal(prettyPrint(r.expr), prettyPrint(e7));
  });

  it(`${prettyPrint(e6)} ⇒ ${prettyPrint(e3)}`, () => {
    const r1 = arenaEval.stepOnce(e6);
    const r2 = arenaEval.stepOnce(r1.expr);
    const r3 = arenaEval.stepOnce(r2.expr);

    assert.ok(r1.altered && r2.altered && r3.altered);
    assert.equal(prettyPrint(r3.expr), prettyPrint(e3));
  });
});

describe('symbolic and arena reduction equivalence', () => {
  const seed = 'df394b';
  const normalizeTests = 19;
  const minLength = 5;
  const maxLength = 12;
  const rs: RandomSeed = create(seed);

  it('runs random-expression normalisation checks', () => {
    for (let t = 0; t < normalizeTests; ++t) {
      const len   = rs.intBetween(minLength, maxLength);
      const input = randExpression(rs, len);

      const arenaNormal = arenaEval.reduce(input);
      const symNormal   = symbolicEvaluator.reduce(input);

      assert.equal(
        prettyPrint(arenaNormal),
        prettyPrint(symNormal),
        `expected: ${prettyPrint(symNormal)}, got: ${prettyPrint(arenaNormal)}`
      );
    }
  });
});

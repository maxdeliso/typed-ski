import { expect } from 'chai';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { createParserState } from '../../lib/parser/parserState.js';
import { parseTripLang, parseTripLangDefinition } from '../../lib/parser/tripLang.js';
import { fileURLToPath } from 'url';
import { mkSystemFVar, mkSystemFAbs, mkSystemFTAbs } from '../../lib/terms/systemF.js';
import { cons } from '../../lib/cons.js';
import { mkVar } from '../../lib/terms/lambda.js';
import { TypedLambda } from '../../lib/types/typedLambda.js';
import { SKIExpression } from '../../lib/ski/expression.js';
import { S, K, I } from '../../lib/ski/terminal.js';

function loadInput(filename: string): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const filePath = resolve(__dirname, 'inputs', filename);
  return readFileSync(filePath, 'utf-8').trim();
}

describe('parseTripLang', () => {
  it('parses polymorphic definitions', () => {
    const input = loadInput('polyId.trip');
    const [term] = parseTripLangDefinition(createParserState(input));

    expect(term).to.deep.equal({
      kind: 'poly',
      name: 'id',
      term: mkSystemFTAbs('a',
        mkSystemFAbs('x',
          { kind: 'type-var', typeName: 'a' },
          mkSystemFVar('x')))
    });
  });

  it('parses typed definitions with explicit types', () => {
    const input = loadInput('typedInc.trip');
    const [term] = parseTripLangDefinition(createParserState(input));

    expect(term).to.deep.equal({
      kind: 'typed',
      name: 'inc',
      type: cons(
        { kind: 'type-var', typeName: 'Int' },
        { kind: 'type-var', typeName: 'Int' }
      ),
      term: {
        kind: 'typed-lambda-abstraction',
        varName: 'x',
        ty: { kind: 'type-var', typeName: 'Int' },
        body: cons<TypedLambda>(
          cons(mkVar('plus'), mkVar('x')),
          mkVar('1')
        )
      },
    });
  });

  it('parses untyped definitions', () => {
    const input = loadInput('untypedDouble.trip');
    const [term] = parseTripLangDefinition(createParserState(input));

    expect(term).to.deep.equal({
      kind: 'untyped',
      name: 'double',
      term: {
        kind: 'lambda-abs',
        name: 'x',
        body: cons(
          mkVar('x'),
          mkVar('x')
        ),
      },
    });
  });

  it('parses complex combinator definitions', () => {
    const input = loadInput('combinatorY.trip');
    const [term] = parseTripLangDefinition(createParserState(input));

    expect(term).to.deep.equal({
      'kind': 'combinator',
      'name': 'Y',
      'term': cons(
        cons<SKIExpression>(
          S,
          cons<SKIExpression>(
            K,
            cons<SKIExpression>(
              cons<SKIExpression>(S, I),
              I
            )
          )
        ),
        cons<SKIExpression> (
          cons<SKIExpression>(
            S,
            cons<SKIExpression>(
              cons<SKIExpression>(
                S,
                cons<SKIExpression>(K, S)
              ),
              K
            )
          ),
          cons<SKIExpression>(
            K,
            cons<SKIExpression>(
              cons<SKIExpression>(S, I),
              I
            )
          )
        )
      )
    });
  });

  it('parses type definitions correctly', () => {
    const input = loadInput('typeNat.trip');
    const [term] = parseTripLangDefinition(createParserState(input));

    const typeVar = (name: string) => ({ kind: 'type-var', typeName: name });
    const X = typeVar('X');

    expect(term).to.deep.equal({
      kind: 'type',
      name: 'Nat',
      type: {
        kind: 'forall',
        typeVar: 'X',
        body: cons(
          cons(X, X),
          cons(X, X)
        )
      }
    });
  });

  it('parses multiple definitions', () => {
    const input = loadInput('church.trip');
    const program = parseTripLang(input);
    const typeVar = (name: string) => ({ kind: 'type-var' as const, typeName: name });
    const X = typeVar('X');
    const A = typeVar('A');

    expect(program).to.deep.equal({
      kind: 'program',
      terms: [
        {
          kind: 'type',
          name: 'Nat',
          type: {
            kind: 'forall',
            typeVar: 'X',
            body: cons(cons(X, X), cons(X, X))
          }
        },
        {
          kind: 'poly',
          name: 'id',
          term: mkSystemFTAbs('A',
            mkSystemFAbs('x', A, mkSystemFVar('x')))
        },
        {
          kind: 'combinator',
          name: 'complex',
          term: cons<SKIExpression>(
            cons<SKIExpression>(
              S,
              cons<SKIExpression>(
                K,
                cons<SKIExpression>(
                  cons<SKIExpression>(S, I),
                  I
                )
              )
            ),
            cons<SKIExpression>(
              cons<SKIExpression>(
                S,
                cons<SKIExpression>(
                  cons<SKIExpression>(S, cons<SKIExpression>(K, S)),
                  K
                )
              ),
              cons<SKIExpression>(
                K,
                cons<SKIExpression>(cons<SKIExpression>(S, I), I)
              )
            )
          )
        },
        {
          kind: 'typed',
          name: 'two',
          type: typeVar('Nat'),
          term: cons<TypedLambda>(
            mkVar('succ'),
            cons<TypedLambda>(mkVar('succ'), mkVar('zero'))
          )
        },
        {
          kind: 'typed',
          name: 'main',
          type: typeVar('Nat'),
          term: mkVar('two')
        }
      ]
    });
  });
});

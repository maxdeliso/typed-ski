import { parse } from '../lib/parser'
import { stepOnce } from '../lib/evaluator'
import { Expression, prettyPrint } from '../lib/expression'

import { describe, it } from 'mocha'
import { assert } from 'chai'

const first = parse('III')
const second = parse('II')
const third = parse('I')
const fourth = parse('KIS')
const fifth = parse('SKKI')
const sixth = parse('SKKII')
const seventh = parse('KI(KI)')

describe('stepOnce', () => {
  const compareExpressions = (a: Expression, b: Expression): void => {
    assert.deepStrictEqual(prettyPrint(a), prettyPrint(b))
    assert.deepStrictEqual(a, b)
  }

  it(`evaluates ${prettyPrint(second)}
      =>
      ${prettyPrint(third)}`, () => {
    const result = stepOnce(second)
    assert(result.altered)
    compareExpressions(result.expr, third)
  })

  it(`evaluates ${prettyPrint(first)}
      =>
      ${prettyPrint(third)}`,
  () => {
    const result = stepOnce(stepOnce(first).expr)
    assert(result.altered)
    compareExpressions(result.expr, third)
  })

  it(`evaluates ${prettyPrint(fourth)}
      =>
      ${prettyPrint(third)}`, () => {
    const result = stepOnce(fourth)
    assert(result.altered)
    compareExpressions(result.expr, third)
  })

  it(`evaluates
      ${prettyPrint(fifth)}
      =>
      ${prettyPrint(seventh)}`, () => {
    const first = stepOnce(fifth)
    assert(first.altered)
    compareExpressions(first.expr, seventh)
  })

  it(`${prettyPrint(sixth)}
      =>
      ${prettyPrint(third)}`,
  () => {
    const firstStep = stepOnce(sixth)
    assert(firstStep.altered)
    const secondStep = stepOnce(firstStep.expr)
    assert(secondStep.altered)
    const thirdStep = stepOnce(secondStep.expr)
    assert(thirdStep.altered)
    compareExpressions(thirdStep.expr, third)
  })
})

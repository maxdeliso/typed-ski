import { parse } from '../lib/parser.mjs'
import { stepOnce } from '../lib/evaluator.mjs'
import { prettyPrint } from '../lib/expression.mjs'

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
  it(`evaluates ${prettyPrint(second)}
      =>
      ${prettyPrint(third)}`, () => {
    const result = stepOnce(second)

    assert(result.altered)

    assert.deepStrictEqual(result.expr, third)
  })

  it(`evaluates ${prettyPrint(first)}
      =>
      ${prettyPrint(third)}`,
  () => {
    const result = stepOnce(stepOnce(first).expr)

    assert(result.altered)

    assert.deepStrictEqual(result.expr, third)
  })

  it(`evaluates ${prettyPrint(fourth)}
      =>
      ${prettyPrint(third)}`, () => {
    const result = stepOnce(fourth)

    assert(result.altered)

    assert.deepStrictEqual(result.expr, third)
  })

  it(`evaluates
      ${prettyPrint(fifth)}
      =>
      ${prettyPrint(seventh)}`, () => {
    const first = stepOnce(fifth)

    assert(first.altered)

    assert.deepStrictEqual(first.expr, seventh)
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

    assert.deepStrictEqual(thirdStep.expr, third)
  })
})

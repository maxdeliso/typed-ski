import { mkVar } from '../lambda/lambda'
import { nt } from '../nonterminal'
import { TypedLambda, mkTypedAbs } from '../typed/typedLambda'
import { Type, arrow, mkTypeVar } from '../typed/types'
import { ParseError } from './parseError'
import { RecursiveDescentBuffer } from './recursiveDescentBuffer'

function parseApp (rdb: RecursiveDescentBuffer): [string, TypedLambda] {
  if (rdb.peek() === '(') {
    rdb.matchLP()
    const lft = rdb.parseVariable()
    const rgt = rdb.parseVariable()
    rdb.matchRP()
    return [`(${lft}${rgt})`, nt(mkVar(lft), mkVar(rgt))]
  } else {
    const varStr = rdb.parseVariable()
    return [varStr, mkVar(varStr)]
  }
}

function parseTypeInternal (rdb: RecursiveDescentBuffer): [string, Type] {
  if (rdb.peek() === '(') {
    rdb.matchLP()
    const [leftTypeLit, leftTy] = parseTypeInternal(rdb)

    if ((rdb.peek() === '→')) {
      rdb.consume()
      const [rightTypeLit, rightTy] = parseTypeInternal(rdb)

      if (rdb.peek() !== ')') throw new ParseError('expected a )')
      rdb.matchRP()

      // '(' <ty_1> '→' <ty_2> ')' )
      return [`(${leftTypeLit}→${rightTypeLit})`, arrow(leftTy, rightTy)]
    } else if (rdb.peek() === ')') {
      rdb.consume()

      if (rdb.peek() === '→') {
        rdb.consume()
        const [nextTypeLit, nextTy] = parseTypeInternal(rdb)

        // '(' <ty_1> ')' '→' <ty_2>
        return [`(${leftTypeLit})→${nextTypeLit}`, arrow(leftTy, nextTy)]
      } else {
        // '(' <ty_1> NOT('→', ')')
        return [leftTypeLit, leftTy]
      }
    } else {
      throw new ParseError('expected a → or ) after ( Type')
    }
  } else {
    const varLit = rdb.parseVariable()

    if (rdb.peek() === '→') {
      rdb.consume()
      const [nextTypeLit, t2] = parseTypeInternal(rdb)

      // <var> '→' <ty>
      return [`${varLit}→${nextTypeLit}`, arrow(mkTypeVar(varLit), t2)]
    } else {
      // <var> NOT('→')
      return [varLit, mkTypeVar(varLit)]
    }
  }
}

function parseTypedLambdaInternal (rdb: RecursiveDescentBuffer):
[string, TypedLambda] {
  let resultStr = ''
  let resultExpr: TypedLambda | undefined

  while (rdb.remaining()) {
    let nextTerm: TypedLambda

    if (rdb.peek() === 'λ') {
      rdb.matchCh('λ')
      const varLit = rdb.parseVariable()
      rdb.matchCh(':')
      const [typeLit, ty] = parseTypeInternal(rdb)
      rdb.matchCh('.')
      const [bodyLit, term] = parseTypedLambdaInternal(rdb)
      const [lambdaLit, lambdaTerm] = [
        `λ${varLit}:${typeLit}.${bodyLit}`,
        mkTypedAbs(varLit, ty, term)
      ]
      nextTerm = lambdaTerm
      resultStr += lambdaLit
    } else {
      const [appLit, appTerm] = parseApp(rdb)
      nextTerm = appTerm
      resultStr += appLit
    }

    if (resultExpr === undefined) {
      resultExpr = nextTerm
    } else {
      resultExpr = nt(resultExpr, nextTerm)
    }
  }

  if (resultExpr === undefined) {
    throw new ParseError('expected a term')
  }

  return [resultStr, resultExpr]
}

export function parseType (input: string): [string, Type] {
  const rdb = new RecursiveDescentBuffer(input)
  return parseTypeInternal(rdb)
}

export function parseTypedLambda (input: string): [string, TypedLambda] {
  const rdb = new RecursiveDescentBuffer(input)
  return parseTypedLambdaInternal(rdb)
}

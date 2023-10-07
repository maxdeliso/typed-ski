import { Appendable } from './appendable'
import { Expression } from './expression'
import { mkVar } from './lambda'
import { nt } from './nonterminal'
import { RecursiveDescentBuffer } from './recursiveDescentBuffer'
import { term, TerminalSymbol } from './terminal'
import { mkTypedAbs, TypedLambda } from './typedLambda'
import { Type, arrow, mkTypeVar } from './types'

export class ParseError extends Error { }

/**
 * @param input a string with an SKI expression to parse.
 * @returns an abstract expression corresponding to the parsed input string,
 * should one exist.
 * @throws {ParseError} if the input string is not a well formed expression.
 */
export function parse (input: string): Expression {
  const app = new Appendable()
  let parenLevel = 0

  for (const ch of input) {
    if (ch === '(') {
      app.appendEmptyBranch()
      parenLevel++
    } else if (ch === ')') {
      parenLevel--

      if (parenLevel < 0) {
        throw new ParseError('mismatched parens! (early)')
      }
    } else if (Object.values(TerminalSymbol).includes(ch as TerminalSymbol)) {
      app.appendSymbol(term(ch as TerminalSymbol))
    } else {
      throw new ParseError('unrecognized char: ' + ch)
    }
  }

  if (parenLevel !== 0) {
    throw new ParseError('mismatched parens! (late)')
  }

  return app.flatten()
}

function parseApp (rdb: RecursiveDescentBuffer): [string, TypedLambda] {
  if (rdb.peek() === '(') {
    rdb.matchCh('(')
    const lft = rdb.parseVariable()
    const rgt = rdb.parseVariable()
    rdb.matchCh(')')
    return [`(${lft}${rgt})`, nt(mkVar(lft), mkVar(rgt))]
  } else {
    const varStr = rdb.parseVariable()
    return [varStr, mkVar(varStr)]
  }
}

function parseTypeInternal (rdb: RecursiveDescentBuffer): [string, Type] {
  if (rdb.peek() === '(') {
    rdb.consume()
    const [leftTypeLit, leftTy] = parseTypeInternal(rdb)

    if ((rdb.peek() === '→')) {
      rdb.consume()
      const [rightTypeLit, rightTy] = parseTypeInternal(rdb)

      if (rdb.peek() !== ')') throw new ParseError('expected a )')
      rdb.consume()

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
  function parseLambda (rdb: RecursiveDescentBuffer): [string, TypedLambda] {
    rdb.matchCh('λ')
    const varLit = rdb.parseVariable()
    rdb.matchCh(':')
    const [typeLit, ty] = parseTypeInternal(rdb)
    rdb.matchCh('.')
    const [bodyLit, term] = parseTypedLambdaInternal(rdb.peel())
    rdb.consumeN(bodyLit.length)
    return [`λ${varLit}:${typeLit}.${bodyLit}`, mkTypedAbs(varLit, ty, term)]
  }

  let resultStr = ''
  let resultExpr: TypedLambda | undefined

  while (rdb.remaining()) {
    let nextTerm: TypedLambda

    if (rdb.peek() === 'λ') {
      const [lambdaLit, lambdaTerm] = parseLambda(rdb)
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

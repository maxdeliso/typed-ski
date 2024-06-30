import { UntypedLambda, mkUntypedAbs, mkVar } from '../lambda/lambda'
import { nt } from '../nonterminal'
import { ParseError } from './parseError'
import { RecursiveDescentBuffer } from './recursiveDescentBuffer'

export function parseLambda (input: string): [string, UntypedLambda] {
  const rdb = new RecursiveDescentBuffer(input)
  return parseUntypedLambdaInternal(rdb)
}

function parseUntypedLambdaInternal (rdb: RecursiveDescentBuffer):
[string, UntypedLambda] {
  let resultStr = ''
  let resultExpr: UntypedLambda | undefined

  while (rdb.remaining()) {
    let nextTerm: UntypedLambda | undefined

    if (rdb.peek() === 'λ') {
      rdb.matchCh('λ')
      const varLit = rdb.parseVariable()
      rdb.matchCh('.')
      const [bodyLit, term] = parseUntypedLambdaInternal(rdb)
      resultStr += `λ${varLit}.${bodyLit}`
      nextTerm = mkUntypedAbs(varLit, term)
    } else if (rdb.peek() === '(') {
      rdb.matchLP()
      const [lit1, t1] = parseUntypedLambdaInternal(rdb)
      resultStr += '(' + lit1
      rdb.matchRP()
      resultStr += ')'
      nextTerm = t1
    } else if (rdb.peek() === ')') {
      break
    } else {
      const singleVar = rdb.parseVariable()
      resultStr += singleVar
      nextTerm = mkVar(singleVar)
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

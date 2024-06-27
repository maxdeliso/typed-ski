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
      const [lambdaLit, lambdaTerm] = parseUntypedLambda(rdb)
      resultStr += lambdaLit
      nextTerm = lambdaTerm
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

    if (nextTerm !== undefined) {
      if (resultExpr === undefined) {
        resultExpr = nextTerm
      } else {
        resultExpr = nt(resultExpr, nextTerm)
      }
    }
  }
  if (resultExpr === undefined) {
    throw new ParseError('expected a term')
  }

  return [resultStr, resultExpr]
}

function parseUntypedLambda (rdb: RecursiveDescentBuffer):
[string, UntypedLambda] {
  rdb.matchCh('λ')
  const varLit = rdb.parseVariable()
  rdb.matchCh('.')
  const [bodyLit, term] = parseLambda(rdb.peelRemaining().buf)
  rdb.consumeN(bodyLit.length)
  return [`λ${varLit}.${bodyLit}`, mkUntypedAbs(varLit, term)]
}

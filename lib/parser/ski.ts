import { SKIExpression } from '../ski/expression.ts';
import { SKITerminalSymbol, term } from '../ski/terminal.ts';
import { Appendable } from './appendable.ts';
import { ParseError } from './parseError.ts';

/**
 * @param input a string with an SKI expression to parse.
 * @returns an abstract expression corresponding to the parsed input string,
 * should one exist.
 * @throws {ParseError} if the input string is not a well formed expression.
 */
export function parseSKI(input: string): SKIExpression {
  const app = new Appendable();
  let parenLevel = 0;

  for (const ch of input) {
    if (ch === '(') {
      app.appendEmptyBranch();
      parenLevel++;
    } else if (ch === ')') {
      parenLevel--;

      if (parenLevel < 0) {
        throw new ParseError('mismatched parens! (early)');
      }
    } else if (Object.values(SKITerminalSymbol)
      .includes(ch as SKITerminalSymbol)) {
      app.appendSymbol(term(ch as SKITerminalSymbol));
    } else {
      throw new ParseError('unrecognized char: ' + ch);
    }
  }

  if (parenLevel !== 0) {
    throw new ParseError('mismatched parens! (late)');
  }

  return app.flatten();
}

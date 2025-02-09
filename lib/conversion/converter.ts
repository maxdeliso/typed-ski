import { ConsCell, cons } from '../cons.js';
import { C, B } from '../consts/combinators.js';
import { LambdaVar, UntypedLambda } from '../terms/lambda.js';
import { SKIExpression } from '../ski/expression.js';
import { S, K, I, SKITerminal } from '../ski/terminal.js';
import { ConversionError } from './conversionError.js';

/**
 * Internal mixed-domain lambda abstraction.
 * (Uses a distinct tag so as not to conflict with untyped lambda abstractions.)
 */
interface LambdaAbsMixed {
  kind: 'lambda-abs-mixed';
  name: string;
  body: LambdaMixed;
}

/**
 * Internal union type for the conversion process.
 * It includes:
 *   - SKI terminals,
 *   - Lambda variables (imported from your untyped lambda module),
 *   - Mixed lambda abstractions (with kind "lambda-abs-mixed"),
 *   - And applications (cons cells) over LambdaMixed.
 */
type LambdaMixed = SKITerminal | LambdaVar | LambdaAbsMixed | ConsCell<LambdaMixed>;

/**
 * Helper constructor for a mixed-domain abstraction.
 */
const mkAbstractMixed = (name: string, body: LambdaMixed): LambdaAbsMixed => ({
  kind: 'lambda-abs-mixed',
  name,
  body,
});

/**
 * Lift an untyped lambda expression (UntypedLambda) into the internal mixed domain.
 * (This simply replaces the abstraction tag "lambda-abs" with "lambda-abs-mixed".)
 */
const lift = (ut: UntypedLambda): LambdaMixed => {
  switch (ut.kind) {
    case 'lambda-var':
      return ut;
    case 'lambda-abs':
      // Convert the untyped abstraction into our mixed abstraction.
      return mkAbstractMixed(ut.name, lift(ut.body));
    case 'non-terminal':
      return cons(lift(ut.lft), lift(ut.rgt));
  }
};

/**
 * NOTE: I referenced https://github.com/ngzhian/ski while coming up with this
 * implementation.
 *
 * @see also https://en.wikipedia.org/wiki/Combinatory_logic#Combinators_B,_C
 *
 * The core conversion function.
 * Recursively converts a mixed-domain lambda expression to one built solely from SKI combinators.
 *
 * The conversion follows these rules:
 *  1. For a variable, return it unchanged.
 *  2. For an application, recursively convert both parts.
 *  3. For an abstraction:
 *     - If the bound variable is not free in the body, convert to (K body).
 *     - Otherwise, inspect the body:
 *          a. If the body is a variable identical to the binder, yield I.
 *          b. If the body is an abstraction, apply Rule 5.
 *          c. If the body is an application, use Rules 6–8.
 */
const convertMixed = (lm: LambdaMixed): LambdaMixed => {
  switch (lm.kind) {
    case 'lambda-var':
      // Rule 1: T[x] ⇒ x
      return lm;
    case 'non-terminal':
      // Rule 2: T[(E₁ E₂)] ⇒ (T[E₁] T[E₂])
      return cons(convertMixed(lm.lft), convertMixed(lm.rgt));
    case 'lambda-abs-mixed':
      if (!free(lm.name, lm.body)) {
        // Rule 3: T[λx.E] ⇒ (K T[E])
        return cons(K, convertMixed(lm.body));
      }
      switch (lm.body.kind) {
        case 'lambda-var':
          if (lm.name === lm.body.name) {
            // Rule 4: T[λx.x] ⇒ I
            return I;
          } else {
            throw new ConversionError('single variable non-match');
          }
        case 'lambda-abs-mixed': {
          const x = lm.name;
          const y = lm.body.name;
          const E = lm.body.body;
          if (free(x, E)) {
            // Rule 5: T[λx.λy.E] ⇒ T[λx.T[λy.E]]
            return convertMixed(mkAbstractMixed(x, convertMixed(mkAbstractMixed(y, E))));
          } else {
            throw new ConversionError('abs x abs y { x not referenced }');
          }
        }
        case 'non-terminal': {
          const x = lm.name;
          const E1 = lm.body.lft;
          const E2 = lm.body.rgt;
          if (free(x, E1) && free(x, E2)) {
            // Rule 6: T[λx.(E₁ E₂)] ⇒ (S T[λx.E₁] T[λx.E₂])
            return cons(
              cons(S, convertMixed(mkAbstractMixed(x, E1))),
              convertMixed(mkAbstractMixed(x, E2))
            );
          } else if (free(x, E1) && !free(x, E2)) {
            // Rule 7: T[λx.(E₁ E₂)] ⇒ (C T[λx.E₁] T[E₂])
            return cons(
              cons(C, convertMixed(mkAbstractMixed(x, E1))),
              convertMixed(E2)
            );
          } else if (!free(x, E1) && free(x, E2)) {
            // Rule 8: T[λx.(E₁ E₂)] ⇒ (B T[E₁] T[λx.E₂])
            return cons(
              cons(B, convertMixed(E1)),
              convertMixed(mkAbstractMixed(x, E2))
            );
          } else {
            throw new ConversionError('x not free in E1 or E2');
          }
        }
        default:
          throw new ConversionError('unexpected body kind in lambda abstraction');
      }
    case 'terminal':
      // Already a SKI terminal—return it as is.
      return lm;
  }
};

const free = (name: string, lm: LambdaMixed): boolean => {
  switch (lm.kind) {
    case 'lambda-var':
      return lm.name === name;
    case 'non-terminal':
      return free(name, lm.lft) || free(name, lm.rgt);
    case 'lambda-abs-mixed':
      // If the abstraction binds the variable 'name', then it is not free.
      if (lm.name === name) {
        return false;
      } else {
        return free(name, lm.body);
      }
    case 'terminal':
      // SKI terminals do not contribute any free variables.
      return false;
  }
};

/**
 * Checks that the given mixed-domain lambda expression contains no lambda abstractions,
 * returning a SKI expression.
 */
const assertCombinator = (lm: LambdaMixed): SKIExpression => {
  switch (lm.kind) {
    case 'terminal':
      return lm;
    case 'non-terminal':
      if (
        lm.lft.kind === 'lambda-var' || lm.lft.kind === 'lambda-abs-mixed' ||
        lm.rgt.kind === 'lambda-var' || lm.rgt.kind === 'lambda-abs-mixed'
      ) {
        throw new ConversionError('lambda abstraction detected in non-terminal');
      }
      return cons(assertCombinator(lm.lft), assertCombinator(lm.rgt));
    default:
      throw new ConversionError('lambda abstraction detected at top');
  }
};

/**
 * Public function.
 * Converts an untyped lambda expression (UntypedLambda) into an SKI expression.
 */
export const convertLambda = (ut: UntypedLambda): SKIExpression => {
  const lifted = lift(ut);
  const converted = convertMixed(lifted);
  return assertCombinator(converted);
};

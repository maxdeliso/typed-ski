import { SystemFTerm } from '../../terms/systemF.js';
import { TypedLambda } from '../../types/typedLambda.js';
import { UntypedLambda } from '../../terms/lambda.js';
import { isNonTerminalNode } from './predicates.js';

export function mkBranch<T extends SystemFTerm | TypedLambda | UntypedLambda>(n: T): T[] {
  if (isNonTerminalNode(n)) {
    return [n.rgt, n.lft];
  }

  switch (n.kind) {
    case 'systemF-abs':
    case 'systemF-type-abs':
    case 'typed-lambda-abstraction':
      return [n.body] as T[];
    case 'systemF-type-app':
      return [n.term] as T[];
    default:
      return [];
  }
}

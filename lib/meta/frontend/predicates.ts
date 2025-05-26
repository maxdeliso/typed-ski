import { SystemFTerm } from '../../terms/systemF.js';
import { TypedLambda } from '../../types/typedLambda.js';
import { UntypedLambda } from '../../terms/lambda.js';

export const isNonTerminalNode = <T extends { kind: string }>(n: T):
  n is T & { kind: 'non-terminal'; lft: T; rgt: T } =>
  n.kind === 'non-terminal';

export function needsRebuild(n: SystemFTerm | TypedLambda | UntypedLambda): boolean {
  if (isNonTerminalNode(n)) {
    return true;
  }

  switch (n.kind) {
    case 'systemF-abs':
    case 'systemF-type-abs':
    case 'systemF-type-app':
    case 'typed-lambda-abstraction':
      return true;
    default:
      return false;
  }
}

export function needsReplace(
  n: SystemFTerm | TypedLambda | UntypedLambda,
  termName: string
): boolean {
  switch (n.kind) {
    case 'systemF-var':
      return n.name === termName;
    case 'lambda-var':
      return n.name === termName;
    default:
      return false;
  }
}

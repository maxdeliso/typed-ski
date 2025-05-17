import { SystemFTerm } from '../../terms/systemF.js';
import { TypedLambda } from '../../types/typedLambda.js';
import { UntypedLambda } from '../../terms/lambda.js';
import { TripLangTerm } from '../trip.js';
import { substituteSystemFType } from '../../types/systemF.js';
import { BaseType } from '../../types/types.js';

export const replace = <T extends SystemFTerm | TypedLambda | UntypedLambda>(n: T, term: TripLangTerm): T => {
  if (n.kind === 'systemF-var' && term.kind === 'poly') {
    return term.term as T;
  }
  if (n.kind === 'lambda-var' && term.kind === 'typed') {
    return term.term as T;
  }
  if (term.kind === 'untyped') {
    return term.term as T;
  }
  return n;
};

export function typedTypeReplace(n: TypedLambda, typeRef: string, targetBase: BaseType): TypedLambda {
  if (n.kind !== 'typed-lambda-abstraction') {
    return n;
  }
  const newTy = substituteSystemFType(n.ty, typeRef, targetBase);
  return {
    ...n,
    ty: newTy,
  };
}


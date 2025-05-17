import { prettyPrintSKI } from '../../index.js';
import { prettyPrintUntypedLambda } from '../../terms/lambda.js';
import { prettyPrintSystemF } from '../../terms/systemF.js';
import { prettyPrintTypedLambda } from '../../types/typedLambda.js';
import { prettyPrintTy } from '../../types/types.js';
import { TripLangTerm } from '../trip.js';

const def = ' := ';

export function prettyTerm(dt: TripLangTerm): string {
  switch (dt.kind) {
    case 'poly':
      return dt.name + def + prettyPrintSystemF(dt.term);
    case 'typed':
      return dt.name + def + prettyPrintTypedLambda(dt.term);
    case 'untyped':
      return dt.name + def + prettyPrintUntypedLambda(dt.term);
    case 'combinator':
      return dt.name + def + prettyPrintSKI(dt.term);
    case 'type':
      return dt.name + def + prettyPrintTy(dt.type);
  }
}

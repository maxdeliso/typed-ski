import { bracketLambda, eraseSystemF } from '../../index.js';
import { eraseTypedLambda } from '../../types/typedLambda.js';
import { TripLangTerm } from '../trip.js';
import { CompilationError } from './compilation.js';

export function termLevel(dt: TripLangTerm): number {
  switch (dt.kind) {
    case 'poly':
      return 4;
    case 'typed':
      return 3;
    case 'untyped':
      return 2;
    case 'combinator':
      return 1;
    case 'type':
      return -1;
  }
}

export function lower(dt: TripLangTerm): TripLangTerm {
  switch (dt.kind) {
    case 'poly': {
      const erased = eraseSystemF(dt.term);

      return {
        kind: 'typed',
        name: dt.name,
        type: undefined, // note: we'll check it after all the symbols are resolved
        term: erased
      };
    }
    case 'typed': {
      const erased = eraseTypedLambda(dt.term);

      return {
        kind: 'untyped',
        name: dt.name,
        term: erased
      };
    }

    case 'untyped': {
      const erased = bracketLambda(dt.term);

      return {
        kind: 'combinator',
        name: dt.name,
        term: erased
      };
    }

    case 'combinator': {
      return dt; // fixed point
    }

    case 'type':
      throw new CompilationError(
        'Cannot lower a type',
        'resolve',
        { type: dt }
      );
  }
}

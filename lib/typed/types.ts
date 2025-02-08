import { ConsCell, cons } from '../cons.ts';
import { UntypedLambda } from '../lambda/lambda.ts';
import { TypedLambda, mkTypedAbs, Context } from './typedLambda.ts';

export interface TypeVariable {
  kind: 'type-var',
  typeName: string
}

export type Type
  = TypeVariable
  | ConsCell<Type>;

export const mkTypeVar = (name: string): TypeVariable => ({
  kind: 'type-var',
  typeName: name
});

export const arrow = (a: Type, b: Type): Type => cons<Type>(a, b);

// a b c
// a (b c)
// (a (b c))
// NOTE: type application is right associative
export const arrows = (...tys: Type[]): Type => tys.reduceRight(
  (acc, ty) => cons<Type>(ty, acc)
);

/**
 * @param a some type
 * @param b another type
 * @returns true if the types are literally the same (i.e. composed of the
 * same literals)
 */
export const typesLitEq = (a: Type, b: Type): boolean => {
  if (a.kind === 'type-var' && b.kind === 'type-var') {
    return a.typeName === b.typeName;
  } else if (a.kind === 'non-terminal' && b.kind === 'non-terminal') {
    return typesLitEq(a.lft, b.lft) && typesLitEq(a.rgt, b.rgt);
  } else {
    return false;
  }
};

export const prettyPrintTy = (ty: Type): string => {
  if (ty.kind === 'type-var') {
    return ty.typeName;
  } else {
    return `(${prettyPrintTy(ty.lft)}→${prettyPrintTy(ty.rgt)})`;
  }
};

/**
 * This function runs a simplified variant of Algorithm W.
 * https://en.wikipedia.org/wiki/Hindley%E2%80%93Milner_type_system
 *
 * @param term a term in the untyped lambda calculus.
 * @returns [the term with types added, the type of that term].
 * @throws TypeError if no valid type could be deduced.
 */
export const inferType = (
  term: UntypedLambda
): [TypedLambda, Type] => {
  const absBindings = new Map<string, Type>();
  const inferredContext = new Map<string, Type>();

  let inferred = algorithmW(term, tyVars(), absBindings, inferredContext);

  inferredContext.forEach((combinedTy, termName) => {
    const originalTy = absBindings.get(termName);

    if (originalTy !== undefined && !typesLitEq(combinedTy, originalTy)) {
      inferred = substituteType(inferred, originalTy, combinedTy);
    }
  });

  const normalizationMappings = new Map<string, string>();
  const vars = tyVars();
  inferredContext.forEach((ty, termName) => {
    inferredContext.set(termName, normalizeTy(ty, normalizationMappings, vars));
  });
  const normalizedType = normalizeTy(inferred, normalizationMappings, vars);

  const typedTerm = attachTypes(term, inferredContext);
  return [typedTerm, normalizedType];
};

const algorithmW = (
  term: UntypedLambda,
  nextVar: () => TypeVariable,
  varBindings: Context,
  constraints: Context): Type => {
  switch (term.kind) {
    case 'lambda-var': {
      const contextType = varBindings.get(term.name);
      if (contextType !== undefined) {
        return contextType;
      } else {
        return nextVar();
      }
    }
    case 'lambda-abs': {
      const paramType = nextVar();
      varBindings.set(term.name, paramType);
      constraints.set(term.name, paramType);
      const bodyType = algorithmW(term.body, nextVar, varBindings, constraints);
      return arrow(paramType, bodyType);
    }

    case 'non-terminal': {
      const leftTy = algorithmW(term.lft, nextVar, varBindings, constraints);
      const rgtTy = algorithmW(term.rgt, nextVar, varBindings, constraints);
      const result = nextVar();
      unify(leftTy, arrow(rgtTy, result), constraints);
      return result;
    }
  }
};

export const unify = (t1: Type, t2: Type, context: Context): void => {
  if (typesLitEq(t1, t2)) {
    return;
  }

  // If t1 is a type variable, bind it to t2 (after an occurs check).
  if (t1.kind === 'type-var') {
    // occursIn will throw if t1 occurs in t2.
    if (occursIn(t1, t2)) {
      throw new TypeError(
        `Occurs check failed: ${t1.typeName} occurs in ${prettyPrintTy(t2)}`
      );
    }
    // Apply the substitution in the entire context.
    for (const [key, ty] of context.entries()) {
      context.set(key, substituteType(ty, t1, t2));
    }
    return;
  }

  // Similarly, if t2 is a type variable, bind it to t1.
  if (t2.kind === 'type-var') {
    if (occursIn(t2, t1)) {
      throw new TypeError(
        `Occurs check failed: ${t2.typeName} occurs in ${prettyPrintTy(t1)}`
      );
    }
    for (const [key, ty] of context.entries()) {
      context.set(key, substituteType(ty, t2, t1));
    }
    return;
  }

  unify(t1.lft, t2.lft, context);
  unify(t1.rgt, t2.rgt, context);
};

export const substituteType = (original: Type, lft: Type, rgt: Type): Type => {
  if (typesLitEq(lft, original)) {
    if (lft.kind === 'type-var' && occursIn(lft, rgt)) {
      throw new TypeError(
        `Occurs check failed: ${lft.typeName} occurs in ${prettyPrintTy(rgt)}`
      );
    }
    return rgt;
  }

  switch (original.kind) {
    case 'type-var':
      return original;
    case 'non-terminal':
      return cons(
        substituteType(original.lft, lft, rgt),
        substituteType(original.rgt, lft, rgt)
      );
  }
};

function monoInts(): () => number {
  let num = 0;

  const generator = () => {
    const ret = num;
    num = num + 1;
    return ret;
  };

  return generator;
}

function tyVars(): () => TypeVariable {
  const ordinals = monoInts();

  const generator = () => {
    const offset = ordinals();
    if (offset > 25) {
      throw new Error('too many variables');
    }
    const str = String.fromCharCode(97 + offset);
    return mkTypeVar(str);
  };

  return generator;
}

const occursIn = (tv: TypeVariable, ty: Type): boolean => {
  if (ty.kind === 'type-var') {
    return ty.typeName === tv.typeName;
  } else {
    return occursIn(tv, ty.lft) || occursIn(tv, ty.rgt);
  }
};

const normalizeTy = (
  ty: Type,
  mapping: Map<string, string> = new Map<string, string>(),
  vars: () => TypeVariable): Type => {
  switch (ty.kind) {
    case 'type-var': {
      const mapped = mapping.get(ty.typeName);

      if (mapped === undefined) {
        const newVar = vars();
        mapping.set(ty.typeName, newVar.typeName);
        return newVar;
      } else {
        return mkTypeVar(mapped);
      }
    }
    case 'non-terminal':
      return cons(
        normalizeTy(ty.lft, mapping, vars),
        normalizeTy(ty.rgt, mapping, vars)
      );
  }
};

const attachTypes = (
  untyped: UntypedLambda,
  types: Context
): TypedLambda => {
  switch (untyped.kind) {
    case 'lambda-var':
      return untyped;
    case 'lambda-abs': {
      const ty = types.get(untyped.name);

      if (ty === undefined) {
        throw new TypeError('missing a type for term: ' + untyped.name);
      }

      return mkTypedAbs(
        untyped.name,
        ty,
        attachTypes(untyped.body, types)
      );
    }
    case 'non-terminal':
      return cons(
        attachTypes(untyped.lft, types),
        attachTypes(untyped.rgt, types)
      );
  }
};

export const normalize = (ty: Type): Type => {
  const mapping = new Map<string, string>();
  const vars = tyVars();
  return normalizeTy(ty, mapping, vars);
};

import { cons } from '../cons.ts';
import { Type, mkTypeVariable } from './types.ts';
import { varSource } from './varSource.ts';

/**
 * Recursively renames type variables to produce a normalized type.
 */
export const normalizeTy = (
  ty: Type,
  mapping: Map<string, string> = new Map<string, string>(),
  vars: () => ReturnType<typeof mkTypeVariable>
): Type => {
  switch (ty.kind) {
    case 'type-var': {
      const mapped = mapping.get(ty.typeName);
      if (mapped === undefined) {
        const newVar = vars();
        mapping.set(ty.typeName, newVar.typeName);
        return newVar;
      } else {
        return mkTypeVariable(mapped);
      }
    }
    case 'non-terminal':
      return cons(
        normalizeTy(ty.lft, mapping, vars),
        normalizeTy(ty.rgt, mapping, vars)
      );
  }
};

export const normalize = (ty: Type): Type => {
  const mapping = new Map<string, string>();
  const vars = varSource();
  return normalizeTy(ty, mapping, vars);
};

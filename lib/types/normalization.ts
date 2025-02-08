import { cons } from '../cons.ts';
import { BaseType, mkTypeVariable } from './types.ts';
import { varSource } from './varSource.ts';

/**
 * Recursively renames type variables to produce a normalized type.
 */
export const normalizeTy = (
  ty: BaseType,
  mapping: Map<string, string> = new Map<string, string>(),
  vars: () => ReturnType<typeof mkTypeVariable>
): BaseType => {
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
    case 'forall': {
      // Normalize the bound variable (you might want to leave it as is or rename it)
      // For simplicity, we leave the bound variable unchanged but normalize the body.
      return {
        kind: 'forall',
        typeVar: ty.typeVar,
        body: normalizeTy(ty.body, mapping, vars)
      };
    }
    default:
      throw new Error('Unhandled type case in normalizeTy');
  }
};

export const normalize = (ty: BaseType): BaseType => {
  const mapping = new Map<string, string>();
  const vars = varSource();
  return normalizeTy(ty, mapping, vars);
};

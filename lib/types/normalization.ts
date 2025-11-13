/**
 * Type normalization and alpha-equivalence.
 *
 * This module provides functionality for normalizing types by renaming
 * type variables to canonical forms, enabling alpha-equivalence checking.
 *
 * @module
 */
import { arrow } from "./types.ts";
import { type BaseType, mkTypeVariable } from "./types.ts";
import { varSource } from "./varSource.ts";

/**
 * Recursively renames type variables to produce a normalized type.
 */
export const normalizeTy = (
  ty: BaseType,
  mapping: Map<string, string> = new Map(),
  vars: () => ReturnType<typeof mkTypeVariable>,
): [BaseType, Map<string, string>] => {
  switch (ty.kind) {
    case "type-var": {
      const mapped = mapping.get(ty.typeName);
      if (mapped === undefined) {
        const newVar = vars();
        const newMapping = new Map(mapping);
        newMapping.set(ty.typeName, newVar.typeName);
        return [mkTypeVariable(newVar.typeName), newMapping];
      } else {
        return [mkTypeVariable(mapped), mapping];
      }
    }
    case "non-terminal": {
      const [lftType, lftMapping] = normalizeTy(ty.lft, mapping, vars);
      const [rgtType, rgtMapping] = normalizeTy(ty.rgt, lftMapping, vars);
      return [arrow(lftType, rgtType), rgtMapping];
    }
    case "forall": {
      const newVar = vars();
      const newMapping = new Map(mapping);
      newMapping.set(ty.typeVar, newVar.typeName);
      const [bodyType, bodyMapping] = normalizeTy(ty.body, newMapping, vars);
      return [{
        kind: "forall",
        typeVar: newVar.typeName,
        body: bodyType,
      }, bodyMapping];
    }
  }
};

export const normalize = (ty: BaseType): BaseType => {
  const mapping = new Map<string, string>();
  const vars = varSource();
  return normalizeTy(ty, mapping, vars)[0];
};

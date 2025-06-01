import { cons } from "../cons.ts";
import type { AVLTree } from "../data/avl/avlNode.ts";
import {
  createStringMap,
  insertStringMap,
  searchStringMap,
} from "../data/map/stringMap.ts";
import { type BaseType, mkTypeVariable } from "./types.ts";
import { varSource } from "./varSource.ts";

/**
 * Recursively renames type variables to produce a normalized type.
 */
export const normalizeTy = (
  ty: BaseType,
  mapping: AVLTree<string, string> = createStringMap(),
  vars: () => ReturnType<typeof mkTypeVariable>,
): [BaseType, AVLTree<string, string>] => {
  switch (ty.kind) {
    case "type-var": {
      const mapped = searchStringMap(mapping, ty.typeName);
      if (mapped === undefined) {
        const newVar = vars();
        const newMapping = insertStringMap(
          mapping,
          ty.typeName,
          newVar.typeName,
        );
        return [mkTypeVariable(newVar.typeName), newMapping];
      } else {
        return [mkTypeVariable(mapped), mapping];
      }
    }
    case "non-terminal": {
      const [lftType, lftMapping] = normalizeTy(ty.lft, mapping, vars);
      const [rgtType, rgtMapping] = normalizeTy(ty.rgt, lftMapping, vars);
      return [cons(lftType, rgtType), rgtMapping];
    }
    case "forall": {
      const newVar = vars();
      const newMapping = insertStringMap(mapping, ty.typeVar, newVar.typeName);
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
  const mapping = createStringMap();
  const vars = varSource();
  return normalizeTy(ty, mapping, vars)[0];
};

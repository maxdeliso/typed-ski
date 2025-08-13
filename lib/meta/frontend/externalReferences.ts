import {
  type AVLTree,
  createEmptyAVL,
  insertAVL,
  searchAVL,
} from "../../data/avl/avlNode.ts";
import { compareStrings } from "../../data/map/stringMap.ts";
import type { BaseType } from "../../types/types.ts";
import type { TripLangValueType } from "../trip.ts";
import { CompilationError } from "./compilation.ts";

/**
 * Collects all free (external) term and type references appearing inside a TripLang value.
 *
 * A reference is considered external if it is not bound by any enclosing abstraction in the value.
 *
 * @param td the TripLang value to analyze (System F term, typed/untyped lambda, SKI expression, or type)
 * @returns a pair of AVL maps: [freeTermRefs, freeTypeRefs], each mapping the referenced name to its node
 */
export function externalReferences(td: TripLangValueType): [
  AVLTree<string, TripLangValueType>,
  AVLTree<string, BaseType>,
] {
  let externalTermRefs = createEmptyAVL<string, TripLangValueType>();
  let externalTypeRefs = createEmptyAVL<string, BaseType>();
  let absBindMap = createEmptyAVL<string, TripLangValueType>();
  const defStack: TripLangValueType[] = [td];

  while (defStack.length) {
    const current = defStack.pop();

    if (current === undefined) {
      throw new CompilationError(
        "Underflow in external references stack",
        "resolve",
        { stack: defStack },
      );
    }

    switch (current.kind) {
      case "systemF-var": {
        const external =
          searchAVL(absBindMap, current.name, compareStrings) === undefined;

        if (external) {
          externalTermRefs = insertAVL(
            externalTermRefs,
            current.name,
            current,
            compareStrings,
          );
        }

        break;
      }

      case "lambda-var": {
        const external =
          searchAVL(absBindMap, current.name, compareStrings) === undefined;

        if (external) {
          externalTermRefs = insertAVL(
            externalTermRefs,
            current.name,
            current,
            compareStrings,
          );
        }

        break;
      }

      case "type-var": {
        const external =
          searchAVL(absBindMap, current.typeName, compareStrings) === undefined;

        if (external) {
          externalTypeRefs = insertAVL(
            externalTypeRefs,
            current.typeName,
            current,
            compareStrings,
          );
        }

        break;
      }

      case "lambda-abs": {
        defStack.push(current.body);
        absBindMap = insertAVL(
          absBindMap,
          current.name,
          current.body,
          compareStrings,
        );
        break;
      }

      case "systemF-abs": {
        defStack.push(current.typeAnnotation);
        defStack.push(current.body);
        absBindMap = insertAVL(
          absBindMap,
          current.name,
          current.body,
          compareStrings,
        );
        break;
      }

      case "systemF-type-abs": {
        defStack.push(current.body);
        absBindMap = insertAVL(
          absBindMap,
          current.typeVar,
          current.body,
          compareStrings,
        );
        break;
      }

      case "typed-lambda-abstraction": {
        defStack.push(current.ty);
        defStack.push(current.body);
        absBindMap = insertAVL(
          absBindMap,
          current.varName,
          current.body,
          compareStrings,
        );
        break;
      }

      case "forall":
        defStack.push(current.body);
        absBindMap = insertAVL(
          absBindMap,
          current.typeVar,
          current.body,
          compareStrings,
        );
        break;

      case "systemF-type-app": {
        defStack.push(current.term);
        defStack.push(current.typeArg);
        break;
      }

      case "terminal":
        // ignore - no bindings possible
        break;

      case "non-terminal": {
        defStack.push(current.lft);
        defStack.push(current.rgt);
        break;
      }
    }
  }

  return [externalTermRefs, externalTypeRefs];
}

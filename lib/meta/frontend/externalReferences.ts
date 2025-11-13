/**
 * External reference analysis for TripLang values.
 *
 * This module provides functionality to collect all free (external) references
 * in TripLang values, including System F terms, typed/untyped lambda expressions,
 * SKI expressions, and types. It tracks bound variables to determine which
 * references are external.
 *
 * @module
 */
import type { BaseType } from "../../types/types.ts";
import type { TripLangValueType } from "../trip.ts";
import { CompilationError } from "./compilation.ts";

/**
 * Collects all free (external) term and type references appearing inside a TripLang value.
 *
 * A reference is considered external if it is not bound by any enclosing abstraction in the value.
 *
 * @param td the TripLang value to analyze (System F term, typed/untyped lambda, SKI expression, or type)
 * @returns a pair of Maps: [freeTermRefs, freeTypeRefs], each mapping the referenced name to its node
 */
export function externalReferences(td: TripLangValueType): [
  Map<string, TripLangValueType>,
  Map<string, BaseType>,
] {
  const externalTermRefs = new Map<string, TripLangValueType>();
  const externalTypeRefs = new Map<string, BaseType>();
  const absBindMap = new Map<string, TripLangValueType>();
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
        const external = !absBindMap.has(current.name);

        if (external) {
          externalTermRefs.set(current.name, current);
        }

        break;
      }

      case "lambda-var": {
        const external = !absBindMap.has(current.name);

        if (external) {
          externalTermRefs.set(current.name, current);
        }

        break;
      }

      case "type-var": {
        const external = !absBindMap.has(current.typeName);

        if (external) {
          externalTypeRefs.set(current.typeName, current);
        }

        break;
      }

      case "lambda-abs": {
        defStack.push(current.body);
        absBindMap.set(current.name, current.body);
        break;
      }

      case "systemF-abs": {
        defStack.push(current.typeAnnotation);
        defStack.push(current.body);
        absBindMap.set(current.name, current.body);
        break;
      }

      case "systemF-type-abs": {
        defStack.push(current.body);
        absBindMap.set(current.typeVar, current.body);
        break;
      }

      case "typed-lambda-abstraction": {
        defStack.push(current.ty);
        defStack.push(current.body);
        absBindMap.set(current.varName, current.body);
        break;
      }

      case "forall":
        defStack.push(current.body);
        absBindMap.set(current.typeVar, current.body);
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

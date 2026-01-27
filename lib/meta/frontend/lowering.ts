/**
 * Term lowering and conversion utilities for TripLang.
 *
 * This module provides functions for converting between different term levels
 * and abstraction levels, including System F to typed lambda calculus conversion.
 *
 * @module
 */

import type { SystemFTerm } from "../../terms/systemF.ts";
import type { TypedLambda } from "../../types/typedLambda.ts";
import { createTypedApplication } from "../../types/typedLambda.ts";
import { parseNatLiteralIdentifier } from "../../consts/nat.ts";
import { makeTypedChurchNumeral } from "../../types/natLiteral.ts";
import { typecheck } from "../../types/systemF.ts";

/**
 * Converts System F to typed lambda calculus, preserving type annotations
 *
 * This function handles the conversion from polymorphic lambda calculus (System F)
 * to simply typed lambda calculus by:
 * - Converting System F variables to lambda variables
 * - Converting System F abstractions to typed lambda abstractions
 * - Erasing type abstractions and type applications
 * - Converting applications to typed applications
 */
export function systemFToTypedLambda(term: SystemFTerm): TypedLambda {
  switch (term.kind) {
    case "systemF-var": {
      const literalValue = parseNatLiteralIdentifier(term.name);
      if (literalValue !== null) {
        return makeTypedChurchNumeral(literalValue);
      }
      return { kind: "lambda-var", name: term.name };
    }
    case "systemF-abs":
      return {
        kind: "typed-lambda-abstraction",
        varName: term.name,
        ty: term.typeAnnotation,
        body: systemFToTypedLambda(term.body),
      };
    case "systemF-type-abs":
      // Erase type abstraction - just return the body
      return systemFToTypedLambda(term.body);
    case "systemF-type-app":
      // Erase type application - just return the term
      return systemFToTypedLambda(term.term);
    case "systemF-let": {
      const typeOfValue = typecheck(term.value);
      return createTypedApplication(
        {
          kind: "typed-lambda-abstraction",
          varName: term.name,
          ty: typeOfValue,
          body: systemFToTypedLambda(term.body),
        },
        systemFToTypedLambda(term.value),
      );
    }
    default:
      // Handle non-terminal (application)
      return createTypedApplication(
        systemFToTypedLambda(term.lft),
        systemFToTypedLambda(term.rgt),
      );
  }
}

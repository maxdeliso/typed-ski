/**
 * Branch builders for substitution algorithms.
 *
 * This module provides utility functions for building branches during
 * substitution operations, extracting child nodes from different term types.
 *
 * @module
 */
import type { SystemFTerm } from "../../terms/systemF.ts";
import type { TypedLambda } from "../../types/typedLambda.ts";
import type { UntypedLambda } from "../../terms/lambda.ts";
import { isNonTerminalNode } from "./predicates.ts";

export function mkBranch<T extends SystemFTerm | TypedLambda | UntypedLambda>(
  n: T,
): T[] {
  if (isNonTerminalNode(n)) {
    return [n.rgt, n.lft];
  }

  switch (n.kind) {
    case "systemF-abs":
    case "systemF-type-abs":
    case "typed-lambda-abstraction":
      return [n.body] as T[];
    case "systemF-type-app":
      return [n.term] as T[];
    case "systemF-let":
      return [n.body, n.value] as T[];
    default:
      return [];
  }
}

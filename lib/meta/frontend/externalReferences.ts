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
import { parseNatLiteralIdentifier } from "../../consts/nat.ts";

/**
 * Memoization cache for external references computation.
 * Uses WeakMap to avoid memory leaks - entries are garbage collected when AST nodes are no longer referenced.
 */
const refCache = new WeakMap<
  TripLangValueType,
  [Map<string, TripLangValueType>, Map<string, BaseType>]
>();

/**
 * Collects all free (external) term and type references appearing inside a TripLang value.
 *
 * A reference is considered external if it is not bound by any enclosing abstraction in the value.
 *
 * Uses memoization to avoid recomputing references for the same AST nodes.
 *
 * @param td the TripLang value to analyze (System F term, typed/untyped lambda, SKI expression, or type)
 * @returns a pair of Maps: [freeTermRefs, freeTypeRefs], each mapping the referenced name to its node
 */
export function externalReferences(td: TripLangValueType): [
  Map<string, TripLangValueType>,
  Map<string, BaseType>,
] {
  // Check cache first
  const cached = refCache.get(td);
  if (cached) {
    return cached;
  }

  const externalTermRefs = new Map<string, TripLangValueType>();
  const externalTypeRefs = new Map<string, BaseType>();
  const absBindMap = new Map<string, TripLangValueType>();

  // Iterative collector with tail-call optimization for App chains
  collectIterative(td, externalTermRefs, externalTypeRefs, absBindMap);

  const result: [Map<string, TripLangValueType>, Map<string, BaseType>] = [
    externalTermRefs,
    externalTypeRefs,
  ];

  // Cache result for future lookups
  refCache.set(td, result);

  return result;
}

/**
 * Iterative collector to prevent stack overflow on deep ASTs (like lists).
 * Uses tail-call optimization for App chains to handle lists efficiently.
 */
function collectIterative(
  root: TripLangValueType,
  externalTermRefs: Map<string, TripLangValueType>,
  externalTypeRefs: Map<string, BaseType>,
  _absBindMap: Map<string, TripLangValueType>,
): void {
  // Stack stores nodes to visit and their surrounding lexical scope.
  // Optimization: For App chains (lists), we don't change scope, so we share the Set reference.
  const stack: {
    term: TripLangValueType;
    bound: Map<string, TripLangValueType>;
  }[] = [
    { term: root, bound: new Map() },
  ];

  while (stack.length > 0) {
    let { term, bound } = stack.pop()!;

    // "Tail Call" loop: Flatten the spine of Applications to avoid stack growth
    // This turns list traversal from O(N) stack to O(1) stack.
    while (true) {
      switch (term.kind) {
        case "systemF-var": {
          const literalValue = parseNatLiteralIdentifier(term.name);
          if (literalValue !== null) {
            break;
          }
          const external = !bound.has(term.name);
          if (external) {
            externalTermRefs.set(term.name, term);
          }
          break;
        }

        case "lambda-var": {
          const external = !bound.has(term.name);
          if (external) {
            externalTermRefs.set(term.name, term);
          }
          break;
        }

        case "type-var": {
          const external = !bound.has(term.typeName);
          if (external) {
            externalTypeRefs.set(term.typeName, term);
          }
          break;
        }

        case "non-terminal": {
          // STRUCTURE: App(fn, arg) or (lft rgt)
          // For lists: App(App(Cons, Head), Tail) -> Tail is 'rgt'.
          // We push 'lft' to the stack and loop on 'rgt' to linearize the list.
          stack.push({ term: term.lft, bound }); // Push function/left side
          term = term.rgt; // Loop on argument/right side (tail)
          continue; // Jump back to start of while(true) with new 'term'
        }

        case "type-app": {
          stack.push({ term: term.fn, bound });
          term = term.arg;
          continue;
        }

        case "systemF-abs": {
          // Abs(name, type, body) -> New Scope
          const newBound = new Map(bound);
          newBound.set(term.name, term.body);
          // Can't loop easily because bound changed; push and break.
          stack.push({ term: term.typeAnnotation, bound });
          stack.push({ term: term.body, bound: newBound });
          break;
        }

        case "lambda-abs": {
          const newBound = new Map(bound);
          newBound.set(term.name, term.body);
          stack.push({ term: term.body, bound: newBound });
          break;
        }

        case "typed-lambda-abstraction": {
          const newBound = new Map(bound);
          newBound.set(term.varName, term.body);
          stack.push({ term: term.ty, bound });
          stack.push({ term: term.body, bound: newBound });
          break;
        }

        case "systemF-let": {
          // Let(name, value, body)
          // 1. Visit value (current scope)
          stack.push({ term: term.value, bound });

          // 2. Visit body (new scope)
          const newBound = new Map(bound);
          newBound.set(term.name, term.body);
          stack.push({ term: term.body, bound: newBound });
          break;
        }

        case "systemF-match": {
          stack.push({ term: term.scrutinee, bound });
          stack.push({ term: term.returnType, bound });
          for (const arm of term.arms) {
            const armBound = new Map(bound);
            for (const param of arm.params) {
              armBound.set(param, arm.body);
            }
            stack.push({ term: arm.body, bound: armBound });
          }
          break;
        }

        case "systemF-type-abs": {
          const newBound = new Map(bound);
          newBound.set(term.typeVar, term.body);
          term = term.body; // Types don't shadow terms, pass through
          bound = newBound;
          continue;
        }

        case "systemF-type-app": {
          stack.push({ term: term.term, bound });
          term = term.typeArg;
          continue;
        }

        case "forall": {
          const newBound = new Map(bound);
          newBound.set(term.typeVar, term.body);
          term = term.body;
          bound = newBound;
          continue;
        }

        case "terminal":
          // ignore - no bindings possible
          break;
      }
      // If we didn't 'continue', we are done with this node.
      break;
    }
  }
}

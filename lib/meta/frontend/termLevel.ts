/**
 * Term level management and lowering operations.
 *
 * This module provides functionality for managing term levels in the
 * type hierarchy and lowering terms from higher levels to lower levels
 * (e.g., System F → typed lambda → untyped lambda → SKI).
 *
 * @module
 */
import { bracketLambda, eraseSystemF } from "../../index.ts";
import {
  createApplication,
  mkUntypedAbs,
  mkVar,
  type UntypedLambda,
} from "../../terms/lambda.ts";
import { eraseTypedLambda } from "../../types/typedLambda.ts";
import type { TripLangTerm } from "../trip.ts";
import { CompilationError } from "./errors.ts";
import { freeTermVars, fresh } from "./substitution.ts";
import type { SKIExpression } from "../../ski/expression.ts";
import { SKITerminalSymbol, term } from "../../ski/terminal.ts";

const INTRINSIC_TERMS: Readonly<Record<string, SKIExpression>> = {
  eqU8: term(SKITerminalSymbol.EqU8),
  ltU8: term(SKITerminalSymbol.LtU8),
  divU8: term(SKITerminalSymbol.DivU8),
  modU8: term(SKITerminalSymbol.ModU8),
  addU8: term(SKITerminalSymbol.AddU8),
  readOne: term(SKITerminalSymbol.ReadOne),
  writeOne: term(SKITerminalSymbol.WriteOne),
};

function applyFixpoint(name: string, body: UntypedLambda): UntypedLambda {
  const free = freeTermVars(body);
  free.delete(name);
  const avoid = new Set([...free, name]);

  const fName = fresh("__rec_f", avoid);
  avoid.add(fName);
  const xName = fresh("__rec_x", avoid);
  avoid.add(xName);
  const vName = fresh("__rec_v", avoid);

  // The Z-Combinator logic
  // 1. x x
  const xx = createApplication(mkVar(xName), mkVar(xName));
  // 2. x x v
  const xxv = createApplication(xx, mkVar(vName));
  // 3. \v. x x v  (Delay thunk)
  const delayed = mkUntypedAbs(vName, xxv);
  // 4. f (\v. x x v)
  const fDelayed = createApplication(mkVar(fName), delayed);
  // 5. \x. f (\v. x x v)
  const inner = mkUntypedAbs(xName, fDelayed);

  const z = mkUntypedAbs(fName, createApplication(inner, inner));
  const recFn = mkUntypedAbs(name, body);
  return createApplication(z, recFn);
}

export function termLevel(dt: TripLangTerm): number {
  switch (dt.kind) {
    case "poly":
      return 4;
    case "typed":
      return 3;
    case "untyped":
      return 2;
    case "combinator":
    case "native":
      return 1;
    case "type":
      return -1;
    case "data":
      return -1;
    case "module":
    case "import":
    case "export":
      return 0;
  }
}

export function lower(dt: TripLangTerm): TripLangTerm {
  switch (dt.kind) {
    case "poly": {
      const erased = eraseSystemF(dt.term);
      const lowered = dt.rec ? applyFixpoint(dt.name, erased) : erased;

      return {
        kind: "untyped",
        name: dt.name,
        term: lowered,
      };
    }
    case "typed": {
      const erased = eraseTypedLambda(dt.term);

      return {
        kind: "untyped",
        name: dt.name,
        term: erased,
      };
    }

    case "untyped": {
      const erased = bracketLambda(dt.term);

      return {
        kind: "combinator",
        name: dt.name,
        term: erased,
      };
    }

    case "combinator": {
      return dt; // fixed point
    }

    case "native": {
      const intrinsic = INTRINSIC_TERMS[dt.name];
      if (!intrinsic) {
        throw new CompilationError(
          `Unknown native intrinsic: ${dt.name}`,
          "resolve",
          { term: dt },
        );
      }
      return {
        kind: "combinator",
        name: dt.name,
        term: intrinsic,
      };
    }

    case "type":
      throw new CompilationError(
        "Cannot lower a type",
        "resolve",
        { type: dt },
      );
    case "data":
      throw new CompilationError(
        "Cannot lower a data definition",
        "resolve",
        { term: dt },
      );
    case "module":
    case "import":
    case "export":
      return dt; // these don't lower
  }
}

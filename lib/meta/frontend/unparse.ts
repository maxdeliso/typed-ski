/**
 * Unparsing utilities for TripLang terms.
 *
 * This module provides unparsing functionality for TripLang terms,
 * delegating to the appropriate unparser based on term type.
 *
 * @module
 */
import { unparseSKI } from "../../index.ts";
import { unparseUntypedLambda } from "../../parser/untyped.ts";
import { unparseSystemF } from "../../parser/systemFTerm.ts";
import { unparseTypedLambda } from "../../parser/typedLambda.ts";
import { unparseType } from "../../parser/type.ts";
import type { TripLangProgram, TripLangTerm } from "../trip.ts";

export function unparseTerm(dt: TripLangTerm): string {
  switch (dt.kind) {
    case "poly":
      return `poly${dt.rec ? " rec" : ""} ${dt.name}${
        dt.type ? ` : ${unparseType(dt.type)}` : ""
      } = ${unparseSystemF(dt.term)}`;
    case "typed":
      return `typed ${dt.name}${
        dt.type ? ` : ${unparseType(dt.type)}` : ""
      } = ${unparseTypedLambda(dt.term)}`;
    case "untyped":
      return `untyped ${dt.name} = ${unparseUntypedLambda(dt.term)}`;
    case "combinator":
      return `combinator ${dt.name} = ${unparseSKI(dt.term)}`;
    case "native":
      return `native ${dt.name} : ${unparseType(dt.type)}`;
    case "type":
      return `type ${dt.name} = ${unparseType(dt.type)}`;
    case "data": {
      const params = dt.typeParams.length > 0
        ? ` ${dt.typeParams.join(" ")}`
        : "";
      const ctors = dt.constructors
        .map((ctor) =>
          ctor.fields.length > 0
            ? `${ctor.name} ${ctor.fields.map(unparseType).join(" ")}`
            : ctor.name
        )
        .join(" | ");
      return `data ${dt.name}${params} = ${ctors}`;
    }
    case "module":
      return `module ${dt.name}`;
    case "import":
      return `import ${dt.name} ${dt.ref}`;
    case "export":
      return `export ${dt.name}`;
  }
}

export function unparseProgram(program: TripLangProgram): string {
  return program.terms.map(unparseTerm).join("\n");
}

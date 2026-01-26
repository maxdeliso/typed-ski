/**
 * Pretty printing utilities for TripLang terms.
 *
 * This module provides pretty printing functionality for TripLang terms,
 * delegating to the appropriate pretty printer based on term type.
 *
 * @module
 */
import { unparseSKI } from "../../index.ts";
import { unparseUntypedLambda } from "../../parser/untyped.ts";
import { unparseSystemF } from "../../parser/systemFTerm.ts";
import { unparseTypedLambda } from "../../parser/typedLambda.ts";
import { unparseType } from "../../parser/type.ts";
import type { TripLangTerm } from "../trip.ts";

const def = " := ";

export function prettyTerm(dt: TripLangTerm): string {
  switch (dt.kind) {
    case "poly":
      return `${dt.name}${dt.rec ? " (rec)" : ""}${def}${
        unparseSystemF(dt.term)
      }`;
    case "typed":
      return dt.name + def + unparseTypedLambda(dt.term);
    case "untyped":
      return dt.name + def + unparseUntypedLambda(dt.term);
    case "combinator":
      return dt.name + def + unparseSKI(dt.term);
    case "type":
      return dt.name + def + unparseType(dt.type);
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
      return `import ${dt.name} from ${dt.ref}`;
    case "export":
      return `export ${dt.name}`;
  }
}

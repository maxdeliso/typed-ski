import { prettyPrintSKI } from "../../index.ts";
import { prettyPrintUntypedLambda } from "../../terms/lambda.ts";
import { prettyPrintSystemF } from "../../terms/systemF.ts";
import { prettyPrintTypedLambda } from "../../types/typedLambda.ts";
import { prettyPrintTy } from "../../types/types.ts";
import { TripLangTerm } from "../trip.ts";

const def = " := ";

export function prettyTerm(dt: TripLangTerm): string {
  switch (dt.kind) {
    case "poly":
      return dt.name + def + prettyPrintSystemF(dt.term);
    case "typed":
      return dt.name + def + prettyPrintTypedLambda(dt.term);
    case "untyped":
      return dt.name + def + prettyPrintUntypedLambda(dt.term);
    case "combinator":
      return dt.name + def + prettyPrintSKI(dt.term);
    case "type":
      return dt.name + def + prettyPrintTy(dt.type);
  }
}

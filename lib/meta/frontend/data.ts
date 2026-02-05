/**
 * Data definition expansion (Scott encoding) for TripLang.
 *
 * This module expands `data` definitions into a type alias plus constructors
 * encoded as polymorphic System F terms.
 *
 * @module
 */
import type {
  DataDefinition,
  PolyDefinition,
  TripLangProgram,
  TripLangTerm,
  TypeDefinition,
} from "../trip.ts";
import { CompilationError } from "./errors.ts";
import {
  arrow,
  arrows,
  type BaseType,
  mkTypeVariable,
} from "../../types/types.ts";
import { forall } from "../../types/systemF.ts";
import {
  createSystemFApplication,
  mkSystemFAbs,
  mkSystemFTAbs,
  mkSystemFVar,
  type SystemFTerm,
} from "../../terms/systemF.ts";

const RESULT_TYPE_BASE = "R";

function ensureUnique(
  items: string[],
  label: string,
  dataName: string,
): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item)) {
      throw new CompilationError(
        `Duplicate ${label} '${item}' in data ${dataName}`,
        "parse",
        { dataName, item },
      );
    }
    seen.add(item);
  }
}

function freshTypeVarName(base: string, used: Set<string>): string {
  let name = base;
  let idx = 0;
  while (used.has(name)) {
    name = `${base}${idx}`;
    idx++;
  }
  return name;
}

function mkCaseType(fields: BaseType[], resultType: BaseType): BaseType {
  return fields.length === 0 ? resultType : arrows(...fields, resultType);
}

function mkScottType(
  data: DataDefinition,
  resultTypeName: string,
): BaseType {
  const resultType = mkTypeVariable(resultTypeName);
  const caseTypes = data.constructors.map((ctor) =>
    mkCaseType(ctor.fields, resultType)
  );

  let body: BaseType = resultType;
  for (let i = caseTypes.length - 1; i >= 0; i--) {
    body = arrow(caseTypes[i]!, body);
  }

  let type = forall(resultTypeName, body);
  for (let i = data.typeParams.length - 1; i >= 0; i--) {
    type = forall(data.typeParams[i]!, type);
  }
  return type;
}

function mkConstructorTerm(
  data: DataDefinition,
  ctorIndex: number,
  resultTypeName: string,
): SystemFTerm {
  const resultType = mkTypeVariable(resultTypeName);
  const caseTypes = data.constructors.map((ctor) =>
    mkCaseType(ctor.fields, resultType)
  );

  const ctor = data.constructors[ctorIndex]!;
  const fieldNames = ctor.fields.map((_, i) =>
    `__${ctor.name.toLowerCase()}_${i}`
  );
  const caseNames = data.constructors.map((_, i) => `__case${i}`);

  let body: SystemFTerm = mkSystemFVar(caseNames[ctorIndex]!);
  for (const fieldName of fieldNames) {
    body = createSystemFApplication(body, mkSystemFVar(fieldName));
  }

  for (let i = caseNames.length - 1; i >= 0; i--) {
    body = mkSystemFAbs(caseNames[i]!, caseTypes[i]!, body);
  }

  body = mkSystemFTAbs(resultTypeName, body);

  for (let i = fieldNames.length - 1; i >= 0; i--) {
    body = mkSystemFAbs(fieldNames[i]!, ctor.fields[i]!, body);
  }

  for (let i = data.typeParams.length - 1; i >= 0; i--) {
    body = mkSystemFTAbs(data.typeParams[i]!, body);
  }

  return body;
}

function expandDataDefinition(data: DataDefinition): TripLangTerm[] {
  if (data.constructors.length === 0) {
    throw new CompilationError(
      `Data type ${data.name} must define at least one constructor`,
      "parse",
      { data },
    );
  }

  ensureUnique(data.typeParams, "type parameter", data.name);
  ensureUnique(
    data.constructors.map((ctor) => ctor.name),
    "constructor",
    data.name,
  );

  if (data.constructors.some((ctor) => ctor.name === data.name)) {
    throw new CompilationError(
      `Constructor name '${data.name}' conflicts with data type name`,
      "parse",
      { data },
    );
  }

  const usedTypeNames = new Set<string>(data.typeParams);
  usedTypeNames.add(data.name);
  const resultTypeName = freshTypeVarName(RESULT_TYPE_BASE, usedTypeNames);

  const typeDef: TypeDefinition = {
    kind: "type",
    name: data.name,
    type: mkScottType(data, resultTypeName),
  };

  const constructors: PolyDefinition[] = data.constructors.map((ctor, idx) => ({
    kind: "poly",
    name: ctor.name,
    term: mkConstructorTerm(data, idx, resultTypeName),
  }));

  return [typeDef, ...constructors];
}

/**
 * Expands all `data` definitions in a program into a type alias and constructors.
 */
export function expandDataDefinitions(
  program: TripLangProgram,
): TripLangProgram {
  const terms: TripLangTerm[] = [];

  for (const term of program.terms) {
    if (term.kind === "data") {
      terms.push(term, ...expandDataDefinition(term));
    } else {
      terms.push(term);
    }
  }

  return { kind: "program", terms };
}

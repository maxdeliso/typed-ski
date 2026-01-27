/**
 * Term elaboration and desugaring.
 *
 * This module provides functionality for elaborating TripLang terms,
 * including desugaring operations and type annotation propagation
 * for System F terms.
 *
 * @module
 */
import type { SymbolTable, TripLangProgram, TripLangTerm } from "../trip.ts";
import {
  createSystemFApplication,
  mkSystemFAbs,
  mkSystemFTAbs,
  mkSystemFTypeApp,
  type SystemFTerm,
} from "../../terms/systemF.ts";
import type { BaseType } from "../../types/types.ts";
import { CompilationError } from "./compilation.ts";

export function elaborateTerms(
  parsed: TripLangProgram,
  syms: SymbolTable,
): TripLangProgram {
  return {
    kind: "program",
    terms: parsed.terms.map((t) => elaborateTerm(t, syms)),
  };
}

export function elaborateTerm(
  term: TripLangTerm,
  syms: SymbolTable,
): TripLangTerm {
  switch (term.kind) {
    case "poly":
      return {
        ...term,
        term: elaborateSystemF(term.term, syms),
      };
    case "typed":
      return term;
    case "untyped":
      return term;
    case "combinator":
      return term;
    case "type":
      return term;
    case "data":
      return term;
    case "module":
      return term;
    case "import":
      return term;
    case "export":
      return term;
  }
}

function getTypeFromVar(
  term: SystemFTerm,
  syms: SymbolTable,
): BaseType | undefined {
  if (term.kind === "systemF-var") {
    return syms.types.get(term.name)?.type;
  }
  return undefined;
}

export function elaborateSystemF(
  systemF: SystemFTerm,
  syms: SymbolTable,
): SystemFTerm {
  switch (systemF.kind) {
    case "systemF-var":
      return systemF;
    case "systemF-abs":
      return mkSystemFAbs(
        systemF.name,
        systemF.typeAnnotation,
        elaborateSystemF(systemF.body, syms),
      );
    case "systemF-type-abs":
      return mkSystemFTAbs(
        systemF.typeVar,
        elaborateSystemF(systemF.body, syms),
      );
    case "systemF-type-app":
      return mkSystemFTypeApp(
        elaborateSystemF(systemF.term, syms),
        systemF.typeArg,
      );
    case "systemF-match":
      return elaborateMatch(systemF, syms);
    case "systemF-let":
      return {
        kind: "systemF-let",
        name: systemF.name,
        value: elaborateSystemF(systemF.value, syms),
        body: elaborateSystemF(systemF.body, syms),
      };
    case "non-terminal": {
      const elaboratedLft = elaborateSystemF(systemF.lft, syms);
      const elaboratedRgt = elaborateSystemF(systemF.rgt, syms);
      const typeArg = getTypeFromVar(elaboratedRgt, syms);

      if (typeArg) {
        return mkSystemFTypeApp(elaboratedLft, typeArg);
      }

      return createSystemFApplication(elaboratedLft, elaboratedRgt);
    }
  }
}

function elaborateMatch(
  match: Extract<SystemFTerm, { kind: "systemF-match" }>,
  syms: SymbolTable,
): SystemFTerm {
  if (match.arms.length === 0) {
    throw new CompilationError(
      "match must declare at least one arm",
      "elaborate",
    );
  }

  const constructorInfos = match.arms.map((arm) => {
    const info = syms.constructors.get(arm.constructorName);
    if (!info) {
      throw new CompilationError(
        `Unknown constructor '${arm.constructorName}' in match`,
        "elaborate",
        { arm },
      );
    }
    return { arm, info };
  });

  const dataName = constructorInfos[0].info.dataName;
  for (const { info } of constructorInfos) {
    if (info.dataName !== dataName) {
      throw new CompilationError(
        "match arms must all target the same data type",
        "elaborate",
        { dataName, got: info.dataName },
      );
    }
  }

  const dataDef = syms.data.get(dataName);
  if (!dataDef) {
    throw new CompilationError(
      `Missing data definition for ${dataName}`,
      "elaborate",
      { dataName },
    );
  }

  const expectedConstructors = new Set(
    dataDef.constructors.map((ctor) => ctor.name),
  );
  const seenConstructors = new Set<string>();
  for (const { arm } of constructorInfos) {
    if (seenConstructors.has(arm.constructorName)) {
      throw new CompilationError(
        `Duplicate match arm for constructor '${arm.constructorName}'`,
        "elaborate",
        { arm },
      );
    }
    seenConstructors.add(arm.constructorName);
  }

  const missing = Array.from(expectedConstructors).filter((ctor) =>
    !seenConstructors.has(ctor)
  );
  if (missing.length > 0) {
    throw new CompilationError(
      `match is missing constructors: ${missing.join(", ")}`,
      "elaborate",
      { dataName, missing },
    );
  }

  const orderedArms = constructorInfos
    .slice()
    .sort((a, b) => a.info.index - b.info.index)
    .map(({ arm, info }) => {
      const fields = info.constructor.fields;
      if (arm.params.length !== fields.length) {
        throw new CompilationError(
          `Constructor '${arm.constructorName}' expects ${fields.length} parameter(s)`,
          "elaborate",
          { arm, fields },
        );
      }
      let body = elaborateSystemF(arm.body, syms);
      for (let i = arm.params.length - 1; i >= 0; i--) {
        body = mkSystemFAbs(arm.params[i], fields[i], body);
      }
      return body;
    });

  let applied: SystemFTerm = mkSystemFTypeApp(
    elaborateSystemF(match.scrutinee, syms),
    match.returnType,
  );
  for (const armTerm of orderedArms) {
    applied = createSystemFApplication(applied, armTerm);
  }
  return applied;
}

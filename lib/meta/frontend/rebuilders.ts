import { cons } from "../../cons.ts";
import {
  referencesVar,
  substituteSystemFType as substituteType,
} from "../../types/systemF.ts";
import { BaseType } from "../../types/types.ts";
import { TripLangTerm } from "../trip.ts";
import { SystemFTerm } from "../../terms/systemF.ts";
import { TypedLambda } from "../../types/typedLambda.ts";
import { UntypedLambda } from "../../terms/lambda.ts";
import { isNonTerminalNode } from "./predicates.ts";
import { CompilationError } from "./compilation.ts";

export function rebuildNonTerminal<T extends { kind: string }>(
  n: T & { kind: "non-terminal"; lft: T; rgt: T },
  rebuilt: T[],
  consFn: (l: T, r: T) => T,
): T {
  const rgtNew = rebuilt.pop()!;
  const lftNew = rebuilt.pop()!;
  return lftNew === n.lft && rgtNew === n.rgt ? n : consFn(lftNew, rgtNew);
}

export function rebuildSystemFAbs(
  n: SystemFTerm & { kind: "systemF-abs" },
  rebuilt: SystemFTerm[],
): SystemFTerm & { kind: "systemF-abs" } {
  const popped = rebuilt.pop()!;
  return n.body === popped ? n : { ...n, body: popped };
}

export function rebuildTypedLambdaAbs(
  n: TypedLambda & { kind: "typed-lambda-abstraction" },
  rebuilt: TypedLambda[],
): TypedLambda {
  const popped = rebuilt.pop()!;
  return n.body === popped ? n : { ...n, body: popped };
}

export function rebuildTypeAbs(
  n: SystemFTerm & { kind: "systemF-type-abs" },
  rebuilt: SystemFTerm[],
): SystemFTerm & { kind: "systemF-type-abs" } {
  const popped = rebuilt.pop()!;
  return n.body === popped ? n : { ...n, body: popped };
}

export function rebuildTypeApp(
  n: SystemFTerm & { kind: "systemF-type-app" },
  rebuilt: SystemFTerm[],
  nextTypeArg: BaseType,
): SystemFTerm & { kind: "systemF-type-app" } {
  const popped = rebuilt.pop()!;

  return (popped === n.term && nextTypeArg === n.typeArg)
    ? n
    : { ...n, term: popped, typeArg: nextTypeArg };
}

export function polyRebuild(
  n: SystemFTerm,
  rebuilt: SystemFTerm[],
  term: TripLangTerm,
): SystemFTerm {
  if (isNonTerminalNode(n)) {
    return rebuildNonTerminal(n, rebuilt, cons);
  } else if (n.kind === "systemF-abs") {
    return rebuildSystemFAbs(n, rebuilt);
  } else if (n.kind === "systemF-type-abs") {
    return rebuildTypeAbs(n, rebuilt);
  } else if (n.kind === "systemF-type-app") {
    const nextType =
      (term.kind === "type" && referencesVar(n.typeArg, term.name))
        ? substituteType(n.typeArg, term.name, term.type)
        : n.typeArg;
    return rebuildTypeApp(n, rebuilt, nextType);
  } else {
    throw new CompilationError(
      `Unexpected kind: ${JSON.stringify(n)}`,
      "resolve",
      { term: n },
    );
  }
}

export function typedRebuild(
  n: TypedLambda,
  rebuilt: TypedLambda[],
): TypedLambda {
  if (isNonTerminalNode(n)) {
    return rebuildNonTerminal(n, rebuilt, cons);
  } else if (n.kind === "typed-lambda-abstraction") {
    return rebuildTypedLambdaAbs(n, rebuilt);
  } else {
    throw new CompilationError(
      `Unexpected kind: ${JSON.stringify(n)}`,
      "resolve",
      { term: n },
    );
  }
}

export const untypedRebuild = (
  n: UntypedLambda,
  rebuilt: UntypedLambda[],
): UntypedLambda =>
  isNonTerminalNode(n) ? rebuildNonTerminal(n, rebuilt, cons) : n;

export function polyTypeRebuild(
  n: SystemFTerm,
  rebuilt: SystemFTerm[],
  typeRef: string,
  targetBase: BaseType,
): SystemFTerm {
  if (isNonTerminalNode(n)) {
    return rebuildNonTerminal(n, rebuilt, cons);
  } else if (n.kind === "systemF-abs") {
    const nextType = referencesVar(n.typeAnnotation, typeRef)
      ? substituteType(n.typeAnnotation, typeRef, targetBase)
      : n.typeAnnotation;
    const popped = rebuilt.pop()!;

    return {
      ...n,
      body: popped,
      typeAnnotation: nextType,
    };
  } else if (n.kind === "systemF-type-abs") {
    return rebuildTypeAbs(n, rebuilt);
  } else if (n.kind === "systemF-type-app") {
    const nextType = referencesVar(n.typeArg, typeRef)
      ? substituteType(n.typeArg, typeRef, targetBase)
      : n.typeArg;

    return rebuildTypeApp(n, rebuilt, nextType);
  } else {
    throw new CompilationError(
      `Unexpected kind: ${JSON.stringify(n)}`,
      "resolve",
      { term: n },
    );
  }
}

export function typedTypeRebuild(
  n: TypedLambda,
  rebuilt: TypedLambda[],
): TypedLambda {
  if (isNonTerminalNode(n)) {
    return rebuildNonTerminal(n, rebuilt, cons);
  } else if (n.kind === "typed-lambda-abstraction") {
    return rebuildTypedLambdaAbs(n, rebuilt);
  } else {
    throw new CompilationError(
      `Unexpected kind: ${JSON.stringify(n)}`,
      "resolve",
      { term: n },
    );
  }
}

export function typedTypeRebuildTerm(n: TripLangTerm): TripLangTerm {
  switch (n.kind) {
    case "poly":
    case "typed":
    case "untyped":
    case "combinator":
      return n;
    case "type":
      throw new CompilationError(
        `Unexpected kind: ${JSON.stringify(n)}`,
        "resolve",
        { term: n },
      );
  }
}

export function untypedTermRebuild(n: TripLangTerm): TripLangTerm {
  switch (n.kind) {
    case "poly":
    case "typed":
    case "untyped":
    case "combinator":
      return n;
    case "type":
      throw new CompilationError(
        `Unexpected kind ${JSON.stringify(n)}`,
        "resolve",
        { term: n },
      );
  }
}

export function untypedTypeRebuild(n: TripLangTerm): TripLangTerm {
  switch (n.kind) {
    case "poly":
    case "typed":
    case "untyped":
    case "combinator":
      return n;
    case "type":
      throw new CompilationError(
        `Unexpected kind: ${JSON.stringify(n)}`,
        "resolve",
        { term: n },
      );
  }
}

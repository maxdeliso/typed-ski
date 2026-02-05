/**
 * Shared compilation error type for TripLang frontend stages.
 *
 * @module
 */

type CompilationStage =
  | "parse"
  | "index"
  | "elaborate"
  | "resolve"
  | "typecheck";

function stringifyForError(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) => {
    if (typeof currentValue === "bigint") {
      return `${currentValue.toString()}n`;
    }
    return currentValue;
  });
}

function formatTermForError(term: unknown): string {
  if (term && typeof term === "object") {
    const maybeTerm = term as { kind?: unknown; name?: unknown };
    if (
      typeof maybeTerm.kind === "string" && typeof maybeTerm.name === "string"
    ) {
      return `${maybeTerm.kind} ${maybeTerm.name}`;
    }
    if (typeof maybeTerm.kind === "string") {
      return maybeTerm.kind;
    }
    try {
      return stringifyForError(term);
    } catch {
      return String(term);
    }
  }
  return String(term);
}

export class CompilationError extends Error {
  constructor(
    message: string,
    public readonly stage: CompilationStage,
    public override readonly cause?: unknown,
  ) {
    let causeStr = "";
    if (cause && typeof cause === "object") {
      const causeObj = cause as Record<string, unknown>;
      if ("term" in causeObj && causeObj.term !== undefined) {
        causeStr = `\nTerm: ${formatTermForError(causeObj.term)}`;
      }
      if ("error" in causeObj) {
        causeStr += `\nError: ${String(causeObj.error)}`;
      }
      if ("unresolvedTerms" in causeObj || "unresolvedTypes" in causeObj) {
        causeStr += "\nUnresolved references:";
        if ("unresolvedTerms" in causeObj) {
          causeStr += `\nTerms: ${stringifyForError(causeObj.unresolvedTerms)}`;
        }
        if ("unresolvedTypes" in causeObj) {
          causeStr += `\nTypes: ${stringifyForError(causeObj.unresolvedTypes)}`;
        }
      }
    } else if (cause !== undefined) {
      causeStr = `\nCause: ${stringifyForError(cause)}`;
    }
    super(message + causeStr);
    this.name = "CompilationError";
  }
}

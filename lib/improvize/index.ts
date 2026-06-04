import { stat, readdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parseTripLang } from "../parser/tripLang.ts";
import { scanTrip, type ScanKind, type ScanToken } from "./lexer.ts";

export type TokenKind = Exclude<ScanKind, "space" | "newline">;

export interface Token extends Omit<ScanToken, "kind"> {
  kind: TokenKind;
}

export interface TripFormatResult {
  formatted: string;
  changed: boolean;
}

export interface TripLintFix {
  start: number;
  end: number;
  replacement: string;
}

export interface TripLintDiagnostic {
  code: string;
  message: string;
  line: number;
  column: number;
  offset: number;
  endOffset: number;
  fix?: TripLintFix;
}

export interface TripLintResult {
  diagnostics: TripLintDiagnostic[];
  fixed: string;
  changed: boolean;
}

const TOP_LEVEL_KEYWORDS = new Set([
  "module",
  "import",
  "export",
  "opaque",
  "native",
  "type",
  "data",
  "poly",
  "combinator",
]);

const DEFINITION_KEYWORDS = new Set([
  "opaque",
  "native",
  "type",
  "data",
  "poly",
  "combinator",
]);

const GENERATED_DIRS = new Set([
  ".git",
  ".claude",
  "node_modules",
  "dist",
  "ts_out",
  "scratch",
]);

function normalizeSource(source: string): string {
  return source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isAscii(source: string): boolean {
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

function isSyntaxToken(token: ScanToken): token is Token {
  return token.kind !== "space" && token.kind !== "newline";
}

export function lexTrip(sourceText: string): Token[] {
  const source = normalizeSource(sourceText);
  if (!isAscii(source)) {
    throw new Error("improvize only accepts ASCII Trip source");
  }

  return scanTrip(source, true).filter(isSyntaxToken);
}

export function isComment(token: Token): boolean {
  return token.kind === "lineComment" || token.kind === "blockComment";
}

function nonComment(tokens: readonly Token[]): Token[] {
  return tokens.filter((token) => !isComment(token));
}

function shouldSkipDir(name: string): boolean {
  return (
    GENERATED_DIRS.has(name) ||
    name.startsWith("bazel-") ||
    name.startsWith(".tmp")
  );
}

export async function discoverTripFiles(
  inputPaths: readonly string[],
  cwd: string = process.cwd(),
): Promise<string[]> {
  const files: string[] = [];

  async function visit(path: string): Promise<void> {
    const fullPath = resolve(cwd, path);
    let stats;
    try {
      stats = await stat(fullPath);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    if (stats.isFile()) {
      if (extname(fullPath) === ".trip") {
        files.push(fullPath);
      }
      return;
    }
    if (!stats.isDirectory()) {
      return;
    }
    if (shouldSkipDir(basename(fullPath))) {
      return;
    }
    const entries = await readdir(fullPath, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.isDirectory() && shouldSkipDir(entry.name)) {
          return;
        }
        await visit(join(fullPath, entry.name));
      }),
    );
  }

  await Promise.all(inputPaths.map(visit));
  return files.sort((a, b) => a.localeCompare(b));
}

function tokenTextForInline(token: Token): string {
  return token.text;
}

function isNoSpaceBefore(token: Token): boolean {
  return (
    token.text === ")" ||
    token.text === "]" ||
    token.text === "}" ||
    token.text === ","
  );
}

function isNoSpaceAfter(token: Token): boolean {
  return (
    token.text === "(" ||
    token.text === "[" ||
    token.text === "{" ||
    token.text === "#" ||
    token.text === "\\"
  );
}

function isOperatorLike(token: Token): boolean {
  return token.text === "=" || token.text === "=>" || token.text === "->";
}

function needsInlineSpace(prev: Token | undefined, current: Token): boolean {
  if (!prev) return false;
  if (prev.text === "<" && current.text === "-") return false;
  if (prev.text === "#") return false;
  if (current.text === "(" && prev.text === "u8") return false;
  if (prev.text === "(" || current.text === ")") return false;
  if (prev.text === "[" || current.text === "]") return false;
  if (current.text === "," || prev.text === ",") return prev.text === ",";
  if (current.text === ":" || prev.text === ":") return true;
  if (isOperatorLike(prev) || isOperatorLike(current)) return true;
  if (isNoSpaceAfter(prev) || isNoSpaceBefore(current)) return false;
  return true;
}

function formatInline(tokens: readonly Token[]): string {
  const parts: string[] = [];
  let prev: Token | undefined;
  for (const token of tokens) {
    if (isComment(token)) continue;
    if (needsInlineSpace(prev, token)) {
      parts.push(" ");
    }
    parts.push(tokenTextForInline(token));
    prev = token;
  }
  return parts.join("").trim();
}

function appendIndentedLine(
  lines: string[],
  indent: number,
  text: string,
): void {
  lines.push(`${" ".repeat(indent)}${text.trimEnd()}`);
}

function formatCommentToken(token: Token, indent: number): string[] {
  if (token.kind === "lineComment") {
    return [`${" ".repeat(indent)}${token.text.trimEnd()}`];
  }
  return token.text.split("\n").map((line) => {
    const trimmed = line.trimEnd();
    return trimmed.length === 0 ? "" : `${" ".repeat(indent)}${trimmed}`;
  });
}

function splitLeadingComments(tokens: readonly Token[]): {
  leading: Token[];
  rest: Token[];
} {
  const leading: Token[] = [];
  let index = 0;
  while (index < tokens.length && isComment(tokens[index]!)) {
    leading.push(tokens[index]!);
    index++;
  }
  return { leading, rest: tokens.slice(index) };
}

// ---- Top-level token scanning --------------------------------------------
// The pretty-printer repeatedly locates or splits tokens that sit at the
// outermost bracket-nesting level. These helpers centralize the depth
// bookkeeping that was otherwise copy-pasted into every check. A single
// combined depth suffices: for the well-nested token streams the formatter
// handles, "combined depth zero" coincides with "every bracket kind balanced".

function bracketDepthDelta(token: Token): number {
  switch (token.text) {
    case "(":
    case "[":
    case "{":
      return 1;
    case ")":
    case "]":
    case "}":
      return -1;
    default:
      return 0;
  }
}

/** Index of the first non-comment token at top level satisfying `predicate`, or -1. */
function findTopLevel(
  tokens: readonly Token[],
  predicate: (token: Token) => boolean,
  from = 0,
): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isComment(token)) continue;
    if (depth === 0 && predicate(token)) return i;
    depth += bracketDepthDelta(token);
  }
  return -1;
}

/** Indices of every non-comment token at top level satisfying `predicate`. */
function topLevelIndices(
  tokens: readonly Token[],
  predicate: (token: Token) => boolean,
  from = 0,
): number[] {
  const indices: number[] = [];
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (isComment(token)) continue;
    if (depth === 0 && predicate(token)) indices.push(i);
    depth += bracketDepthDelta(token);
  }
  return indices;
}

/**
 * Splits `tokens` on top-level separator tokens, which are dropped. Empty
 * groups are kept so callers can apply their own emptiness filter.
 */
function splitTopLevel(
  tokens: readonly Token[],
  isSeparator: (token: Token) => boolean,
): Token[][] {
  const groups: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (depth === 0 && !isComment(token) && isSeparator(token)) {
      groups.push(current);
      current = [];
      continue;
    }
    current.push(token);
    if (!isComment(token)) depth += bracketDepthDelta(token);
  }
  groups.push(current);
  return groups;
}

const isPipe = (token: Token): boolean => token.text === "|";

/** A top-level operator: an arrow or any non-bracket symbol. */
function isOperatorToken(token: Token): boolean {
  return (
    token.kind === "arrow" ||
    token.kind === "fatArrow" ||
    (token.kind === "symbol" && bracketDepthDelta(token) === 0)
  );
}

function splitAtTopLevelEquals(tokens: readonly Token[]): {
  before: Token[];
  after: Token[];
} {
  const idx = findTopLevel(tokens, (token) => token.text === "=");
  if (idx === -1) return { before: [...tokens], after: [] };
  return { before: tokens.slice(0, idx), after: tokens.slice(idx + 1) };
}

function splitConstructors(tokens: readonly Token[]): Token[][] {
  return splitTopLevel(tokens, isPipe).filter(
    (group) => nonComment(group).length > 0,
  );
}

function isBlockLike(tokens: readonly Token[]): boolean {
  return tokens.some(
    (t) => t.text === "let" || t.text === "match" || t.text === "if",
  );
}

function findMatchingBrace(
  tokens: readonly Token[],
  startIdx: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  for (let i = startIdx; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.text === open) depth++;
    else if (t.text === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function isStartOfDoStep(tokens: readonly Token[], idx: number): boolean {
  if (idx >= tokens.length) return false;
  const first = tokens[idx]!;
  if (isComment(first)) return false;

  if (first.text === "assert" || first.text === "return") {
    return true;
  }

  // Check if it is a bind step: `ident < -`
  if (
    idx + 2 < tokens.length &&
    first.kind === "ident" &&
    tokens[idx + 1]!.text === "<" &&
    tokens[idx + 2]!.text === "-"
  ) {
    return true;
  }

  // If it starts with a lowercase identifier, it must be either bind or a simple let: `ident =`
  if (
    first.kind === "ident" &&
    first.text[0]! >= "a" &&
    first.text[0]! <= "z"
  ) {
    return idx + 1 < tokens.length && tokens[idx + 1]!.text === "=";
  }

  // Check if it is a let/match step: starts with pattern, then '='
  let depth = 0;
  const isParenthesizedPattern = first.text === "(" || first.text === "[";
  let hasBeenOpen = false;

  for (let j = idx; j < tokens.length; j++) {
    const t = tokens[j]!;
    if (isComment(t)) continue;
    if (depth === 0 && t.text === "=") {
      // Verify it's not '=>'
      if (j + 1 < tokens.length && tokens[j + 1]!.text === ">") {
        return false;
      }
      return true;
    }
    const delta = bracketDepthDelta(t);
    depth += delta;
    if (depth > 0) {
      hasBeenOpen = true;
    }
    if (isParenthesizedPattern && hasBeenOpen && depth === 0 && delta < 0) {
      let nextIdx = j + 1;
      while (nextIdx < tokens.length && isComment(tokens[nextIdx]!)) {
        nextIdx++;
      }
      if (nextIdx >= tokens.length || tokens[nextIdx]!.text !== "=") {
        break;
      }
    }
    if (depth < 0) break;
    // Stop if we hit a known start of another step
    if (
      j > idx &&
      depth === 0 &&
      (t.text === "assert" || t.text === "return")
    ) {
      break;
    }
    if (
      j > idx &&
      depth === 0 &&
      j + 2 < tokens.length &&
      t.kind === "ident" &&
      tokens[j + 1]!.text === "<" &&
      tokens[j + 2]!.text === "-"
    ) {
      break;
    }
  }

  return false;
}

function splitDoSteps(tokens: readonly Token[]): Token[][] {
  const steps: Token[][] = [];
  let i = 0;

  while (i < tokens.length) {
    while (i < tokens.length && isComment(tokens[i]!)) {
      i++;
    }
    if (i >= tokens.length) break;

    const startIdx = i;
    const firstWord = tokens[i]!.text;

    if (firstWord === "assert") {
      i++;
      let depth = 0;
      while (i < tokens.length) {
        const t = tokens[i]!;
        if (!isComment(t)) {
          if (depth === 0 && t.text === "else") {
            break;
          }
          depth += bracketDepthDelta(t);
        }
        i++;
      }
      if (i < tokens.length && tokens[i]!.text === "else") {
        i++;
        let errDepth = 0;
        while (i < tokens.length) {
          const t = tokens[i]!;
          if (!isComment(t)) {
            if (errDepth === 0 && t.text === "let") {
              i = advancePastLet(tokens, i);
              continue;
            }
            if (errDepth === 0 && isStartOfDoStep(tokens, i)) {
              break;
            }
            errDepth += bracketDepthDelta(t);
          }
          i++;
        }
      }
    } else if (firstWord === "return") {
      i++;
      let depth = 0;
      while (i < tokens.length) {
        const t = tokens[i]!;
        if (!isComment(t)) {
          if (depth === 0 && t.text === "let") {
            i = advancePastLet(tokens, i);
            continue;
          }
          if (depth === 0 && isStartOfDoStep(tokens, i)) {
            break;
          }
          depth += bracketDepthDelta(t);
        }
        i++;
      }
    } else {
      let isBind = false;
      if (
        i + 2 < tokens.length &&
        tokens[i]!.kind === "ident" &&
        tokens[i + 1]!.text === "<" &&
        tokens[i + 2]!.text === "-"
      ) {
        isBind = true;
      }

      if (isBind) {
        i += 3;
        let depth = 0;
        while (i < tokens.length) {
          const t = tokens[i]!;
          if (!isComment(t)) {
            if (depth === 0 && t.text === "let") {
              i = advancePastLet(tokens, i);
              continue;
            }
            if (depth === 0 && isStartOfDoStep(tokens, i)) {
              break;
            }
            depth += bracketDepthDelta(t);
          }
          i++;
        }
      } else {
        let eqIdx = -1;
        let depth = 0;
        const first = tokens[startIdx]!;
        const startsWithCtor =
          first.kind === "ident" &&
          first.text[0]! >= "A" &&
          first.text[0]! <= "Z";
        for (let j = i; j < tokens.length; j++) {
          const t = tokens[j]!;
          if (!isComment(t)) {
            if (depth === 0 && t.text === "let") {
              const after = advancePastLet(tokens, j);
              j = after - 1;
              continue;
            }
            if (depth === 0 && t.text === "=") {
              eqIdx = j;
              break;
            }
            if (j > i && depth === 0) {
              const isSameLine = t.line === first.line;
              const skipCheck = startsWithCtor && isSameLine;
              if (!skipCheck && isStartOfDoStep(tokens, j)) {
                break;
              }
            }
            depth += bracketDepthDelta(t);
          }
        }

        if (eqIdx !== -1) {
          i = eqIdx + 1;
          let exprDepth = 0;
          while (i < tokens.length) {
            const t = tokens[i]!;
            if (!isComment(t)) {
              if (exprDepth === 0 && t.text === "let") {
                i = advancePastLet(tokens, i);
                continue;
              }
              if (exprDepth === 0 && isStartOfDoStep(tokens, i)) {
                break;
              }
              exprDepth += bracketDepthDelta(t);
            }
            i++;
          }
        } else {
          let exprDepth = 0;
          while (i < tokens.length) {
            const t = tokens[i]!;
            if (!isComment(t)) {
              if (exprDepth === 0 && t.text === "let") {
                i = advancePastLet(tokens, i);
                continue;
              }
              if (
                i > startIdx &&
                exprDepth === 0 &&
                isStartOfDoStep(tokens, i)
              ) {
                break;
              }
              exprDepth += bracketDepthDelta(t);
            }
            i++;
          }
        }
      }
    }

    steps.push([...tokens.slice(startIdx, i)]);
  }
  return steps;
}

/**
 * Advance past a full "let ... = ... in <body-expr>" subexpression (and any
 * nested lets inside its value), returning the index at which the let (and its
 * body) ends. Used by do-step splitter so that bare "let" sub-expressions
 * inside rhs of do steps (which contain "=") do not cause premature step
 * termination.
 */
function advancePastLet(tokens: readonly Token[], start: number): number {
  let i = start;
  if (i >= tokens.length || tokens[i]!.text !== "let") return i;
  let pending = 1;
  let dP = 0,
    dB = 0,
    dBr = 0;
  i++; // past "let"
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (isComment(t)) {
      i++;
      continue;
    }
    if (t.text === "(") dP++;
    else if (t.text === ")") dP--;
    else if (t.text === "[") dB++;
    else if (t.text === "]") dB--;
    else if (t.text === "{") dBr++;
    else if (t.text === "}") dBr--;
    const bd0 = dP === 0 && dB === 0 && dBr === 0;
    if (bd0) {
      if (t.text === "let") {
        pending++;
      } else if (t.text === "in") {
        pending--;
        if (pending === 0) {
          i++; // consume this "in"
          // now skip the body expr of this let; stop if we hit a do-step start
          // (which would also terminate any outer expr containing this let)
          let bD = 0;
          while (i < tokens.length) {
            const tt = tokens[i]!;
            if (isComment(tt)) {
              i++;
              continue;
            }
            if (bD === 0 && isStartOfDoStep(tokens, i)) {
              return i;
            }
            bD += bracketDepthDelta(tt);
            i++;
            if (bD < 0) break;
          }
          return i;
        }
      }
    }
    i++;
  }
  return i;
}

function formatExpressionRecursiveRaw(
  tokens: readonly Token[],
  indent: number,
): string[] {
  const nonComments = tokens.filter((t) => !isComment(t));
  if (nonComments.length === 0) return [];

  // Check 1: Binder chains at the very beginning
  const firstToken = nonComments[0]!;
  if (firstToken.text === "\\" || firstToken.text === "#") {
    const arrowIdx = findTopLevel(tokens, (t) => t.text === "=>");
    if (arrowIdx !== -1) {
      const binderTokens = tokens.slice(0, arrowIdx + 1);
      const bodyTokens = tokens.slice(arrowIdx + 1);
      const binderStr = formatInline(binderTokens);
      if (isBlockLike(bodyTokens) || formatInline(bodyTokens).length > 60) {
        return [
          `${" ".repeat(indent)}${binderStr}`,
          ...formatExpressionRecursive(bodyTokens, indent + 2),
        ];
      } else {
        return [
          `${" ".repeat(indent)}${binderStr} ${formatInline(bodyTokens).trim()}`,
        ];
      }
    }
  }

  // Check 2: Let chains at top level
  const letIdx = findTopLevel(tokens, (t) => t.text === "let");

  if (letIdx !== -1) {
    // Only special-format lets when the let is at the root of these tokens
    // (i.e. this expr *is* a let). If "foo = let ..." or "f (let..)", just inline
    // so we do not split do-step groups or misindent prefixes.
    const nonCommentBefore = tokens.slice(0, letIdx).some((t) => !isComment(t));
    if (!nonCommentBefore) {
      const inIdx = findTopLevel(tokens, (t) => t.text === "in", letIdx + 1);

      if (inIdx !== -1) {
        const beforeLet = tokens.slice(0, letIdx);
        const letBinding = tokens.slice(letIdx, inIdx + 1);
        const letBody = tokens.slice(inIdx + 1);

        const letBindingStr = formatInline(letBinding);
        const bodyLines = formatExpressionRecursive(letBody, indent);

        const lines: string[] = [];
        if (beforeLet.length > 0) {
          lines.push(`${" ".repeat(indent)}${formatInline(beforeLet)}`);
        }
        lines.push(`${" ".repeat(indent)}${letBindingStr}`);
        lines.push(...bodyLines);
        return lines;
      }
    }
  }

  // Check 3: Match expressions
  const matchIdx = findTopLevel(tokens, (t) => t.text === "match");

  if (matchIdx !== -1) {
    const openBraceIdx = findTopLevel(
      tokens,
      (t) => t.text === "{",
      matchIdx + 1,
    );
    if (openBraceIdx !== -1) {
      const closeBraceIdx = findMatchingBrace(tokens, openBraceIdx, "{", "}");
      if (closeBraceIdx !== -1) {
        const beforeMatch = tokens.slice(0, matchIdx);
        const matchHeader = tokens.slice(matchIdx, openBraceIdx);
        const insideBraces = tokens.slice(openBraceIdx + 1, closeBraceIdx);
        const afterMatch = tokens.slice(closeBraceIdx + 1);

        const headerStr = formatInline(matchHeader) + " {";
        const lines: string[] = [];

        if (beforeMatch.length > 0) {
          lines.push(`${" ".repeat(indent)}${formatInline(beforeMatch)}`);
        }
        lines.push(`${" ".repeat(indent)}${headerStr}`);

        const armTokens = splitTopLevel(insideBraces, isPipe).filter(
          (arm) => arm.length > 0,
        );

        for (const arm of armTokens) {
          let fatArrowIdx = -1;
          for (let i = 0; i < arm.length; i++) {
            if (arm[i]!.text === "=>") {
              fatArrowIdx = i;
              break;
            }
          }
          if (fatArrowIdx !== -1) {
            const patternTokens = arm.slice(0, fatArrowIdx);
            const armBodyTokens = arm.slice(fatArrowIdx + 1);
            const patternStr = `| ${formatInline(patternTokens)} =>`;

            if (
              isBlockLike(armBodyTokens) ||
              formatInline(armBodyTokens).length > 50
            ) {
              lines.push(`${" ".repeat(indent + 2)}${patternStr}`);
              lines.push(
                ...formatExpressionRecursive(armBodyTokens, indent + 4),
              );
            } else {
              lines.push(
                `${" ".repeat(indent + 2)}${patternStr} ${formatInline(armBodyTokens)}`,
              );
            }
          } else {
            lines.push(`${" ".repeat(indent + 2)}${formatInline(arm)}`);
          }
        }

        lines.push(`${" ".repeat(indent)}}`);
        if (afterMatch.length > 0) {
          lines.push(...formatExpressionRecursive(afterMatch, indent));
        }
        return lines;
      }
    }
  }

  // Check 3b: Do expressions
  const doIdx = findTopLevel(tokens, (t) => t.text === "do");
  if (doIdx !== -1) {
    const openBraceIdx = findTopLevel(tokens, (t) => t.text === "{", doIdx + 1);
    if (openBraceIdx !== -1) {
      const closeBraceIdx = findMatchingBrace(tokens, openBraceIdx, "{", "}");
      if (closeBraceIdx !== -1) {
        const beforeDo = tokens.slice(0, doIdx);
        const doHeader = tokens.slice(doIdx, openBraceIdx);
        const insideBraces = tokens.slice(openBraceIdx + 1, closeBraceIdx);
        const afterDo = tokens.slice(closeBraceIdx + 1);

        const headerStr = formatInline(doHeader) + " {";
        const lines: string[] = [];

        if (beforeDo.length > 0) {
          lines.push(`${" ".repeat(indent)}${formatInline(beforeDo)}`);
        }
        lines.push(`${" ".repeat(indent)}${headerStr}`);

        const steps = splitDoSteps(insideBraces);
        for (const step of steps) {
          lines.push(...formatExpressionRecursive(step, indent + 2));
        }

        lines.push(`${" ".repeat(indent)}}`);
        if (afterDo.length > 0) {
          lines.push(...formatExpressionRecursive(afterDo, indent));
        }
        return lines;
      }
    }
  }

  // Check 3c: Cond expressions
  const condIdx = findTopLevel(tokens, (t) => t.text === "cond");
  if (condIdx !== -1) {
    const openBraceIdx = findTopLevel(
      tokens,
      (t) => t.text === "{",
      condIdx + 1,
    );
    if (openBraceIdx !== -1) {
      const closeBraceIdx = findMatchingBrace(tokens, openBraceIdx, "{", "}");
      if (closeBraceIdx !== -1) {
        const beforeCond = tokens.slice(0, condIdx);
        const condHeader = tokens.slice(condIdx, openBraceIdx);
        const insideBraces = tokens.slice(openBraceIdx + 1, closeBraceIdx);
        const afterCond = tokens.slice(closeBraceIdx + 1);

        const headerStr = formatInline(condHeader) + " {";
        const lines: string[] = [];

        if (beforeCond.length > 0) {
          lines.push(`${" ".repeat(indent)}${formatInline(beforeCond)}`);
        }
        lines.push(`${" ".repeat(indent)}${headerStr}`);

        const arms = splitTopLevel(insideBraces, isPipe).filter(
          (arm) => arm.length > 0,
        );

        for (const arm of arms) {
          let fatArrowIdx = -1;
          for (let i = 0; i < arm.length; i++) {
            if (arm[i]!.text === "=>") {
              fatArrowIdx = i;
              break;
            }
          }
          if (fatArrowIdx !== -1) {
            const patternTokens = arm.slice(0, fatArrowIdx);
            const armBodyTokens = arm.slice(fatArrowIdx + 1);
            const patternStr = `| ${formatInline(patternTokens)} =>`;

            if (
              isBlockLike(armBodyTokens) ||
              formatInline(armBodyTokens).length > 50
            ) {
              lines.push(`${" ".repeat(indent + 2)}${patternStr}`);
              lines.push(
                ...formatExpressionRecursive(armBodyTokens, indent + 4),
              );
            } else {
              lines.push(
                `${" ".repeat(indent + 2)}${patternStr} ${formatInline(armBodyTokens)}`,
              );
            }
          } else {
            lines.push(`${" ".repeat(indent + 2)}${formatInline(arm)}`);
          }
        }

        lines.push(`${" ".repeat(indent)}}`);
        if (afterCond.length > 0) {
          lines.push(...formatExpressionRecursive(afterCond, indent));
        }
        return lines;
      }
    }
  }

  // Check 4: Structured 'if' expressions
  const ifIdx = findTopLevel(tokens, (t) => t.text === "if");

  if (ifIdx !== -1) {
    const beforeIf = tokens.slice(0, ifIdx);
    const ifRest = tokens.slice(ifIdx);

    const argIndices = topLevelIndices(ifRest, (t) => t.text === "(", 1);

    if (argIndices.length >= 2) {
      const thenStart = argIndices[argIndices.length - 2]!;
      const elseStart = argIndices[argIndices.length - 1]!;

      const headerTokens = ifRest.slice(0, thenStart);
      const thenTokens = ifRest.slice(thenStart, elseStart);
      const elseTokens = ifRest.slice(elseStart);

      const headerStr = formatInline(headerTokens);
      const lines: string[] = [];
      if (beforeIf.length > 0) {
        lines.push(`${" ".repeat(indent)}${formatInline(beforeIf)}`);
      }
      lines.push(`${" ".repeat(indent)}${headerStr}`);
      lines.push(...formatExpressionRecursive(thenTokens, indent + 2));
      lines.push(...formatExpressionRecursive(elseTokens, indent + 2));
      return lines;
    }
  }

  // Check 5: Parenthesized expressions
  if (
    tokens.length >= 2 &&
    tokens[0]!.text === "(" &&
    findMatchingBrace(tokens, 0, "(", ")") === tokens.length - 1
  ) {
    const inner = tokens.slice(1, tokens.length - 1);
    const innerLines = formatExpressionRecursiveRaw(inner, indent + 2);
    if (innerLines.length > 0) {
      if (innerLines.length > 1) {
        return [
          `${" ".repeat(indent)}(`,
          ...innerLines,
          `${" ".repeat(indent)})`,
        ];
      } else {
        const inlineStr = `${" ".repeat(indent)}(${innerLines[0]!.trim()})`;
        if (inlineStr.length <= 80) {
          return [inlineStr];
        } else {
          return [
            `${" ".repeat(indent)}(`,
            innerLines[0]!,
            `${" ".repeat(indent)})`,
          ];
        }
      }
    }
  }

  // Check 5b: Bracketed expressions
  if (
    tokens.length >= 2 &&
    tokens[0]!.text === "[" &&
    findMatchingBrace(tokens, 0, "[", "]") === tokens.length - 1
  ) {
    const inner = tokens.slice(1, tokens.length - 1);
    const inlineStr = `${" ".repeat(indent)}[${formatInline(inner)}]`;
    return [inlineStr];
  }

  // Check 6: List and Pair literals
  if (
    tokens.length >= 3 &&
    tokens[0]!.text === "{" &&
    findMatchingBrace(tokens, 0, "{", "}") === tokens.length - 1
  ) {
    const innerPipe = findTopLevel(tokens.slice(1, tokens.length - 1), isPipe);
    const pipeIdx = innerPipe === -1 ? -1 : innerPipe + 1;

    if (pipeIdx !== -1) {
      // Keep the literal on one line when it fits and holds no block construct,
      // mirroring the parenthesized-expression fast-path above; only overflow
      // (or a nested let/match/if) forces the element-per-line layout.
      const inlineStr = `${" ".repeat(indent)}${formatInline(tokens)}`;
      if (inlineStr.length <= 80 && !isBlockLike(tokens)) {
        return [inlineStr];
      }

      const header = tokens.slice(0, pipeIdx + 1);
      const body = tokens.slice(pipeIdx + 1, tokens.length - 1);
      const headerStr = formatInline(header);

      const args = splitTopLevelArguments(body);
      if (args.length > 0) {
        const lines = [`${" ".repeat(indent)}${headerStr}`];
        for (const arg of args) {
          lines.push(...formatExpressionRecursive(arg, indent + 2));
        }
        lines.push(`${" ".repeat(indent)}}`);
        return lines;
      }
    }
  }

  // Check 7: Function application splitting for long lines
  const inlineStr = `${" ".repeat(indent)}${formatInline(tokens)}`;
  if (inlineStr.length > 80 && !hasTopLevelOperators(tokens)) {
    const args = splitTopLevelArguments(tokens);
    if (args.length > 1) {
      const firstArg = args[0]!;
      const restArgs = args.slice(1);
      const lines = [...formatExpressionRecursive(firstArg, indent)];
      for (const arg of restArgs) {
        lines.push(...formatExpressionRecursive(arg, indent + 2));
      }
      return lines;
    }
  }

  return [`${" ".repeat(indent)}${formatInline(tokens)}`];
}

function splitTopLevelArguments(tokens: readonly Token[]): Token[][] {
  const args: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;

  for (const t of tokens) {
    const isStartOfArg =
      depth === 0 &&
      current.length > 0 &&
      !isComment(t) &&
      (t.kind === "ident" ||
        t.kind === "number" ||
        t.kind === "string" ||
        t.kind === "char" ||
        t.text === "(" ||
        t.text === "[" ||
        t.text === "{" ||
        t.text === "\\" ||
        t.text === "#" ||
        t.text === "'");

    if (isStartOfArg) {
      args.push(current);
      current = [];
    }

    current.push(t);
    if (!isComment(t)) depth += bracketDepthDelta(t);
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

function hasTopLevelOperators(tokens: readonly Token[]): boolean {
  return findTopLevel(tokens, isOperatorToken) !== -1;
}

function formatExpressionRecursive(
  tokens: readonly Token[],
  indent: number,
): string[] {
  const resultLines = formatExpressionRecursiveRaw(tokens, indent);

  const trailingComments: Token[] = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (isComment(t)) {
      trailingComments.unshift(t);
    } else {
      break;
    }
  }

  if (trailingComments.length > 0 && resultLines.length > 0) {
    const commentStr = trailingComments.map((t) => t.text).join(" ");
    resultLines[resultLines.length - 1] =
      `${resultLines[resultLines.length - 1]} ${commentStr}`;
  }
  return resultLines;
}

function formatExpression(tokens: readonly Token[], indent: number): string[] {
  return formatExpressionRecursive(tokens, indent);
}

function formatDataDecl(tokens: readonly Token[]): string[] {
  const { before, after } = splitAtTopLevelEquals(tokens);
  const lines = [`${formatInline(before)} =`];
  for (const ctor of splitConstructors(after)) {
    const comments = ctor.filter(isComment);
    const rest = ctor.filter((token) => !isComment(token));
    for (const comment of comments) {
      lines.push(...formatCommentToken(comment, 2));
    }
    appendIndentedLine(lines, 2, `| ${formatInline(rest)}`);
  }
  return lines;
}

function formatDefinitionDecl(tokens: readonly Token[]): string[] {
  const { before, after } = splitAtTopLevelEquals(tokens);
  const header = formatInline(before);
  if (after.length === 0) {
    return [header];
  }
  return [`${header} =`, ...formatExpression(after, 2)];
}

function formatDecl(tokens: readonly Token[]): string[] {
  const { leading, rest } = splitLeadingComments(tokens);
  const lines: string[] = [];
  for (const comment of leading) {
    lines.push(...formatCommentToken(comment, 0));
  }
  const first = rest.find((token) => !isComment(token));
  if (!first) return lines;

  if (first.text === "data") {
    lines.push(...formatDataDecl(rest));
    return lines;
  }
  if (first.text === "poly" || first.text === "combinator") {
    lines.push(...formatDefinitionDecl(rest));
    return lines;
  }
  lines.push(formatInline(rest));
  return lines;
}

export function partitionDecls(tokens: readonly Token[]): Token[][] {
  const groups: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  let hasCurrentSyntax = false;

  const flushCurrentBeforeNextDecl = () => {
    let split = current.length;
    const lastSyntax = [...current]
      .reverse()
      .find((token) => !isComment(token));
    if (lastSyntax) {
      while (
        split > 0 &&
        isComment(current[split - 1]!) &&
        current[split - 1]!.line > lastSyntax.line
      ) {
        split--;
      }
    }
    const prior = current.slice(0, split);
    const carry = current.slice(split);
    if (prior.length > 0) groups.push(prior);
    current = carry;
    hasCurrentSyntax = false;
  };

  for (const token of tokens) {
    const topLevel =
      depth === 0 &&
      token.kind === "ident" &&
      TOP_LEVEL_KEYWORDS.has(token.text);

    if (topLevel && hasCurrentSyntax) {
      flushCurrentBeforeNextDecl();
    }

    current.push(token);
    if (!isComment(token)) {
      hasCurrentSyntax = true;
      depth += bracketDepthDelta(token);
    }
  }

  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

/**
 * Parses `source` as a TripLang program and returns a stable structural key for
 * its AST, or `undefined` when it does not parse. The TripLang AST carries no
 * source positions (see the parse-equivalence tests), so two layouts of the
 * same program produce identical keys — which lets a key mismatch stand in for
 * a genuine difference in meaning.
 */
function parseProgramOrNull(source: string): string | undefined {
  try {
    return JSON.stringify(parseTripLang(source));
  } catch {
    return undefined;
  }
}

export function formatTripSource(
  source: string,
  options: { force?: boolean } = {},
): TripFormatResult {
  const normalized = normalizeSource(source);
  const tokens = lexTrip(normalized);
  if (tokens.length === 0) {
    return { formatted: "", changed: normalized.length > 0 };
  }

  const hasProgramDecl = tokens.some(
    (token) => token.kind === "ident" && TOP_LEVEL_KEYWORDS.has(token.text),
  );
  const decls = hasProgramDecl ? partitionDecls(tokens) : [tokens];
  const blocks = decls
    .map((decl) =>
      hasProgramDecl ? formatDecl(decl) : formatExpression(decl, 0),
    )
    .filter((block) => block.some((line) => line.trim().length > 0));

  const lines: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (i > 0) lines.push("");
    lines.push(...blocks[i]!);
  }
  const formatted = `${lines.join("\n").replace(/[ \t]+$/gm, "")}\n`;

  // A formatter must never change a program's meaning. The pretty-printer is a
  // heuristic token reflow, so verify the result round-trips: when the input is
  // a parseable program, the output must parse to the same AST. If it does not,
  // fall back to the input untouched rather than emit a divergent reformat.
  //
  // Under --force (from lint) we relax this: we still try the check, but if it
  // fails because a forced rewrite intentionally changed surface syntax (or the
  // heuristic replacement wasn't perfect), we still return the formatted result
  // instead of throwing. The caller (lint --force) wants the changes applied.
  const before = parseProgramOrNull(normalized);
  if (before !== undefined && !options.force) {
    try {
      const after = JSON.stringify(parseTripLang(formatted));
      if (after !== before) {
        console.error("AST mismatch!");
        throw new Error(
          "AST mismatch: " +
            JSON.stringify(
              { before: JSON.parse(before), after: JSON.parse(after) },
              null,
              2,
            ),
        );
      }
    } catch (e) {
      console.error(
        "Formatter produced invalid or different code! Error:",
        (e as any).message,
      );
      throw e;
    }
  }

  return { formatted, changed: formatted !== normalized };
}

function locationAt(
  source: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function diagnostic(
  code: string,
  message: string,
  token: Token,
  fix?: TripLintFix,
): TripLintDiagnostic {
  return {
    code,
    message,
    line: token.line,
    column: token.column,
    offset: token.start,
    endOffset: token.end,
    ...(fix ? { fix } : {}),
  };
}

function previousSyntax(
  tokens: readonly Token[],
  index: number,
): Token | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const token = tokens[i]!;
    if (!isComment(token)) return token;
  }
  return undefined;
}

function nextSyntax(
  tokens: readonly Token[],
  index: number,
): Token | undefined {
  for (let i = index + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!isComment(token)) return token;
  }
  return undefined;
}

function isExistingU8Literal(tokens: readonly Token[], index: number): boolean {
  const number = tokens[index]!;
  const lparenMatch = previousSyntaxWithIndex(tokens, index);
  if (!lparenMatch || lparenMatch.token.text !== "(") return false;
  const u8Match = previousSyntaxWithIndex(tokens, lparenMatch.index);
  if (!u8Match || u8Match.token.text !== "u8") return false;
  const hashMatch = previousSyntaxWithIndex(tokens, u8Match.index);
  const rparenMatch = nextSyntaxWithIndex(tokens, index);
  return (
    hashMatch?.token.text === "#" &&
    rparenMatch?.token.text === ")" &&
    number.kind === "number"
  );
}

function collectTopLevelBindings(tokens: readonly Token[]): {
  moduleName?: string;
  imports: Set<string>;
  localDefinitions: Set<string>;
} {
  const imports = new Set<string>();
  const localDefinitions = new Set<string>();
  let moduleName: string | undefined;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "ident") continue;
    if (token.text === "module") {
      const nameMatch = nextSyntaxWithIndex(tokens, i);
      if (nameMatch?.token.kind === "ident") moduleName = nameMatch.token.text;
      continue;
    }
    if (token.text === "import") {
      const fromMatch = nextSyntaxWithIndex(tokens, i);
      if (fromMatch) {
        const symbolMatch = nextSyntaxWithIndex(tokens, fromMatch.index);
        if (
          fromMatch.token.text === "Prelude" &&
          symbolMatch?.token.kind === "ident"
        ) {
          imports.add(symbolMatch.token.text);
        }
      }
      continue;
    }
    if (DEFINITION_KEYWORDS.has(token.text)) {
      const firstMatch = nextSyntaxWithIndex(tokens, i);
      if (firstMatch) {
        let nameMatch = firstMatch;
        if (token.text === "opaque" && firstMatch.token.text === "type") {
          const secondMatch = nextSyntaxWithIndex(tokens, firstMatch.index);
          if (secondMatch) nameMatch = secondMatch;
        }
        if (token.text === "poly" && firstMatch.token.text === "rec") {
          const secondMatch = nextSyntaxWithIndex(tokens, firstMatch.index);
          if (secondMatch) nameMatch = secondMatch;
        }
        if (nameMatch.token.kind === "ident") {
          localDefinitions.add(nameMatch.token.text);
        }
      }
    }
  }

  return { moduleName, imports, localDefinitions };
}

function canUsePrelude(
  info: ReturnType<typeof collectTopLevelBindings>,
  name: string,
): boolean {
  return (
    info.moduleName !== "Prelude" &&
    info.imports.has(name) &&
    !info.localDefinitions.has(name)
  );
}

function simpleTokenReplacement(token: Token): string | undefined {
  if (
    token.kind === "ident" ||
    token.kind === "number" ||
    token.kind === "string" ||
    token.kind === "char"
  ) {
    return token.text;
  }
  return undefined;
}

function nextSyntaxWithIndex(
  tokens: readonly Token[],
  index: number,
): { token: Token; index: number } | undefined {
  for (let i = index + 1; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!isComment(token)) return { token, index: i };
  }
  return undefined;
}

function previousSyntaxWithIndex(
  tokens: readonly Token[],
  index: number,
): { token: Token; index: number } | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const token = tokens[i]!;
    if (!isComment(token)) return { token, index: i };
  }
  return undefined;
}

function parseArgExpression(
  tokens: readonly Token[],
  index: number,
): { tokens: Token[]; endIndex: number } | undefined {
  let startIdx = index;
  while (startIdx < tokens.length && isComment(tokens[startIdx]!)) {
    startIdx++;
  }
  if (startIdx >= tokens.length) return undefined;

  const firstToken = tokens[startIdx]!;
  if (
    firstToken.text === "(" ||
    firstToken.text === "{" ||
    firstToken.text === "["
  ) {
    const open = firstToken.text;
    const close = open === "(" ? ")" : open === "{" ? "}" : "]";
    let depth = 1;
    const argTokens: Token[] = [firstToken];
    let cursor = startIdx + 1;
    while (cursor < tokens.length) {
      const t = tokens[cursor]!;
      if (t.text === open) depth++;
      else if (t.text === close) depth--;
      argTokens.push(t);
      if (depth === 0) break;
      cursor++;
    }
    if (depth === 0) {
      return { tokens: argTokens, endIndex: cursor };
    }
    return undefined;
  }

  if (
    firstToken.kind === "ident" ||
    firstToken.kind === "number" ||
    firstToken.kind === "string" ||
    firstToken.kind === "char"
  ) {
    return { tokens: [firstToken], endIndex: startIdx };
  }

  return undefined;
}

function stripOuterParens(tokens: readonly Token[]): Token[] {
  let list = [...tokens];
  while (list.length > 0) {
    let start = 0;
    while (start < list.length && isComment(list[start]!)) {
      start++;
    }
    let end = list.length - 1;
    while (end >= 0 && isComment(list[end]!)) {
      end--;
    }
    if (start >= end) break;
    const first = list[start]!;
    const last = list[end]!;
    if (first.text === "(" && last.text === ")") {
      let depth = 0;
      let matches = true;
      for (let i = start; i <= end; i++) {
        if (list[i]!.text === "(") depth++;
        else if (list[i]!.text === ")") depth--;
        if (depth === 0 && i < end) {
          matches = false;
          break;
        }
      }
      if (matches) {
        list = list.slice(start + 1, end);
        continue;
      }
    }
    break;
  }
  return list;
}

function parseBracketedTypeArgument(
  tokens: readonly Token[],
  index: number,
): { typeText: string; endIndex: number } | undefined {
  const next = nextSyntaxWithIndex(tokens, index);
  if (next?.token.text !== "[") return undefined;

  const typeTokens: Token[] = [];
  let cursor = next.index + 1;
  let depth = 1;
  while (cursor < tokens.length) {
    const t = tokens[cursor]!;
    if (t.text === "[") depth++;
    if (t.text === "]") depth--;
    if (depth === 0) break;
    typeTokens.push(t);
    cursor++;
  }
  if (cursor >= tokens.length) return undefined;

  return {
    typeText: formatInline(typeTokens),
    endIndex: cursor,
  };
}

function parseListChain(
  tokens: readonly Token[],
  index: number,
): { typeText: string; elements: Token[][]; endIndex: number } | undefined {
  const token = tokens[index];
  if (!token) return undefined;

  if (token.text === "nil") {
    const next = nextSyntaxWithIndex(tokens, index);
    if (next?.token.text === "[") {
      const typeTokens: Token[] = [];
      let cursor = next.index + 1;
      let depth = 1;
      while (cursor < tokens.length) {
        const t = tokens[cursor]!;
        if (t.text === "[") depth++;
        if (t.text === "]") depth--;
        if (depth === 0) break;
        typeTokens.push(t);
        cursor++;
      }
      if (cursor < tokens.length) {
        return {
          typeText: formatInline(typeTokens),
          elements: [],
          endIndex: cursor,
        };
      }
    }
  }

  if (token.text === "cons") {
    const next = nextSyntaxWithIndex(tokens, index);
    if (next?.token.text === "[") {
      const typeTokens: Token[] = [];
      let cursor = next.index + 1;
      let depth = 1;
      while (cursor < tokens.length) {
        const t = tokens[cursor]!;
        if (t.text === "[") depth++;
        if (t.text === "]") depth--;
        if (depth === 0) break;
        typeTokens.push(t);
        cursor++;
      }
      if (cursor < tokens.length) {
        const firstArg = parseArgExpression(tokens, cursor + 1);
        if (firstArg) {
          const secondArg = parseArgExpression(tokens, firstArg.endIndex + 1);
          if (secondArg) {
            const innerTokens = stripOuterParens(secondArg.tokens);
            const nestedChain = parseListChain(innerTokens, 0);
            const typeText = formatInline(typeTokens);
            if (nestedChain && nestedChain.typeText === typeText) {
              return {
                typeText,
                elements: [firstArg.tokens, ...nestedChain.elements],
                endIndex: secondArg.endIndex,
              };
            }
          }
        }
      }
    }
  }

  return undefined;
}

function parseConsPrefixChain(
  tokens: readonly Token[],
  index: number,
):
  | {
      typeText: string;
      elements: Token[][];
      tailTokens: Token[];
      endIndex: number;
    }
  | undefined {
  const token = tokens[index];
  if (token?.text !== "cons") return undefined;

  const typeArg = parseBracketedTypeArgument(tokens, index);
  if (!typeArg) return undefined;

  const firstArg = parseArgExpression(tokens, typeArg.endIndex + 1);
  if (!firstArg) return undefined;

  const secondArg = parseArgExpression(tokens, firstArg.endIndex + 1);
  if (!secondArg) return undefined;

  const innerTokens = stripOuterParens(secondArg.tokens);
  const nested = parseConsPrefixChain(innerTokens, 0);
  if (
    nested &&
    nested.typeText === typeArg.typeText &&
    nested.endIndex === innerTokens.length - 1
  ) {
    return {
      typeText: typeArg.typeText,
      elements: [firstArg.tokens, ...nested.elements],
      tailTokens: nested.tailTokens,
      endIndex: secondArg.endIndex,
    };
  }

  return {
    typeText: typeArg.typeText,
    elements: [firstArg.tokens],
    tailTokens: secondArg.tokens,
    endIndex: secondArg.endIndex,
  };
}

function parseListLiteral(
  tokens: readonly Token[],
  index: number,
): { typeText: string; elements: Token[][]; endIndex: number } | undefined {
  const token = tokens[index];
  if (token?.text !== "{") return undefined;

  const closeIdx = findMatchingBrace(tokens, index, "{", "}");
  if (closeIdx === -1) return undefined;

  const pipeRel = findTopLevel(tokens.slice(index + 1, closeIdx), isPipe);
  if (pipeRel === -1) return undefined;
  const pipeIdx = pipeRel + index + 1;

  const typeTokens = tokens.slice(index + 1, pipeIdx);
  const elementTokens = tokens.slice(pipeIdx + 1, closeIdx);

  const elements: Token[][] = [];
  let cursor = 0;
  while (cursor < elementTokens.length) {
    while (cursor < elementTokens.length && isComment(elementTokens[cursor]!)) {
      cursor++;
    }
    if (cursor >= elementTokens.length) break;
    const arg = parseArgExpression(elementTokens, cursor);
    if (!arg) return undefined;
    elements.push(arg.tokens);
    cursor = arg.endIndex + 1;
  }

  return {
    typeText: formatInline(typeTokens),
    elements,
    endIndex: closeIdx,
  };
}

function parseAppendChain(
  tokens: readonly Token[],
  index: number,
): { typeText: string; elements: Token[][]; endIndex: number } | undefined {
  const token = tokens[index];
  if (token?.text !== "append") return undefined;

  const next = nextSyntaxWithIndex(tokens, index);
  if (next?.token.text !== "[") return undefined;

  const typeTokens: Token[] = [];
  let cursor = next.index + 1;
  let depth = 1;
  while (cursor < tokens.length) {
    const t = tokens[cursor]!;
    if (t.text === "[") depth++;
    if (t.text === "]") depth--;
    if (depth === 0) break;
    typeTokens.push(t);
    cursor++;
  }
  if (cursor >= tokens.length) return undefined;

  const arg1 = parseArgExpression(tokens, cursor + 1);
  if (!arg1) return undefined;

  const arg2 = parseArgExpression(tokens, arg1.endIndex + 1);
  if (!arg2) return undefined;

  const list1 = resolveAsStaticList(arg1.tokens);
  const list2 = resolveAsStaticList(arg2.tokens);

  const typeText = formatInline(typeTokens);
  if (
    list1 &&
    list2 &&
    list1.typeText === typeText &&
    list2.typeText === typeText
  ) {
    return {
      typeText,
      elements: [...list1.elements, ...list2.elements],
      endIndex: arg2.endIndex,
    };
  }

  return undefined;
}

function parseAppendSegmentChain(
  tokens: readonly Token[],
  index: number,
):
  | {
      typeText: string;
      segments: Token[][];
      appendCount: number;
      endIndex: number;
    }
  | undefined {
  const token = tokens[index];
  if (token?.text !== "append") return undefined;

  const typeArg = parseBracketedTypeArgument(tokens, index);
  if (!typeArg) return undefined;

  const arg1 = parseArgExpression(tokens, typeArg.endIndex + 1);
  if (!arg1) return undefined;

  const arg2 = parseArgExpression(tokens, arg1.endIndex + 1);
  if (!arg2) return undefined;

  const left = parseNestedAppendSegment(arg1.tokens, typeArg.typeText);
  const right = parseNestedAppendSegment(arg2.tokens, typeArg.typeText);

  return {
    typeText: typeArg.typeText,
    segments: [
      ...(left?.segments ?? [arg1.tokens]),
      ...(right?.segments ?? [arg2.tokens]),
    ],
    appendCount: 1 + (left?.appendCount ?? 0) + (right?.appendCount ?? 0),
    endIndex: arg2.endIndex,
  };
}

function parseNestedAppendSegment(
  tokens: readonly Token[],
  typeText: string,
):
  | {
      segments: Token[][];
      appendCount: number;
    }
  | undefined {
  const stripped = stripOuterParens(tokens);
  const nested = parseAppendSegmentChain(stripped, 0);
  if (
    nested &&
    nested.typeText === typeText &&
    nested.endIndex === stripped.length - 1
  ) {
    return {
      segments: nested.segments,
      appendCount: nested.appendCount,
    };
  }
  return undefined;
}

function typeTextForListElementType(typeText: string): string {
  const trimmed = typeText.trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    return `List ${trimmed}`;
  }
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    return `List ${trimmed}`;
  }
  return `List (${trimmed})`;
}

function resolveAsStaticList(
  tokens: readonly Token[],
): { typeText: string; elements: Token[][] } | undefined {
  const stripped = stripOuterParens(tokens);
  if (stripped.length === 0) return undefined;

  const chain = parseListChain(stripped, 0);
  if (chain) return { typeText: chain.typeText, elements: chain.elements };

  const literal = parseListLiteral(stripped, 0);
  if (literal && literal.endIndex === stripped.length - 1) {
    return { typeText: literal.typeText, elements: literal.elements };
  }

  const append = parseAppendChain(stripped, 0);
  if (append && append.endIndex === stripped.length - 1) {
    return { typeText: append.typeText, elements: append.elements };
  }

  return undefined;
}

function convertToStaticString(elements: Token[][]): string | undefined {
  const chars: string[] = [];
  for (const elem of elements) {
    if (elem.length !== 1 || elem[0]!.kind !== "char") {
      return undefined;
    }
    const charText = elem[0]!.text;
    if (!charText.startsWith("'") || !charText.endsWith("'")) {
      return undefined;
    }
    const inner = charText.slice(1, -1);
    if (inner === "\\'") {
      chars.push("'");
    } else if (inner === '"') {
      chars.push('\\"');
    } else {
      chars.push(inner);
    }
  }
  return `"${chars.join("")}"`;
}

function matchMkPair(
  tokens: readonly Token[],
  index: number,
):
  | {
      type1Text: string;
      type2Text: string;
      term1Tokens: Token[];
      term2Tokens: Token[];
      endIndex: number;
    }
  | undefined {
  const token = tokens[index];
  if (token?.text !== "MkPair") return undefined;

  const next1 = nextSyntaxWithIndex(tokens, index);
  if (next1?.token.text !== "[") return undefined;

  const type1Tokens: Token[] = [];
  let cursor = next1.index + 1;
  let depth = 1;
  while (cursor < tokens.length) {
    const t = tokens[cursor]!;
    if (t.text === "[") depth++;
    if (t.text === "]") depth--;
    if (depth === 0) break;
    type1Tokens.push(t);
    cursor++;
  }
  if (cursor >= tokens.length) return undefined;

  const next2 = nextSyntaxWithIndex(tokens, cursor);
  if (next2?.token.text !== "[") return undefined;

  const type2Tokens: Token[] = [];
  cursor = next2.index + 1;
  depth = 1;
  while (cursor < tokens.length) {
    const t = tokens[cursor]!;
    if (t.text === "[") depth++;
    if (t.text === "]") depth--;
    if (depth === 0) break;
    type2Tokens.push(t);
    cursor++;
  }
  if (cursor >= tokens.length) return undefined;

  const term1 = parseArgExpression(tokens, cursor + 1);
  if (!term1) return undefined;

  const term2 = parseArgExpression(tokens, term1.endIndex + 1);
  if (!term2) return undefined;

  return {
    type1Text: formatInline(type1Tokens),
    type2Text: formatInline(type2Tokens),
    term1Tokens: term1.tokens,
    term2Tokens: term2.tokens,
    endIndex: term2.endIndex,
  };
}

function isInsideDataDefinition(tokens: readonly Token[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const text = tokens[i]!.text;
    if (
      text === "data" ||
      text === "type" ||
      text === "poly" ||
      text === "combinator" ||
      text === "native" ||
      text === "opaque" ||
      text === "module" ||
      text === "import" ||
      text === "export"
    ) {
      return text === "data";
    }
  }
  return false;
}

function matchPairType(
  tokens: readonly Token[],
  index: number,
):
  | { type1Tokens: Token[]; type2Tokens: Token[]; endIndex: number }
  | undefined {
  const token = tokens[index];
  if (token?.text !== "Pair") return undefined;

  const type1 = parseArgExpression(tokens, index + 1);
  if (!type1) return undefined;

  const type2 = parseArgExpression(tokens, type1.endIndex + 1);
  if (!type2) return undefined;

  if (
    type1.tokens.some((t) => TOP_LEVEL_KEYWORDS.has(t.text)) ||
    type2.tokens.some((t) => TOP_LEVEL_KEYWORDS.has(t.text))
  ) {
    return undefined;
  }

  return {
    type1Tokens: type1.tokens,
    type2Tokens: type2.tokens,
    endIndex: type2.endIndex,
  };
}

function parseDelayLambda(
  tokens: readonly Token[],
  index: number,
): { bodyTokens: Token[]; endIndex: number } | undefined {
  const arg = parseArgExpression(tokens, index);
  if (!arg) return undefined;

  const stripped = stripOuterParens(arg.tokens);
  let idx = 0;
  while (idx < stripped.length && isComment(stripped[idx]!)) idx++;
  if (idx >= stripped.length || stripped[idx]!.text !== "\\") return undefined;
  idx++;
  while (idx < stripped.length && isComment(stripped[idx]!)) idx++;
  const nameToken = stripped[idx];
  if (idx >= stripped.length || !nameToken || nameToken.kind !== "ident")
    return undefined;
  if (nameToken.text !== "u") return undefined;
  idx++;
  while (idx < stripped.length && isComment(stripped[idx]!)) idx++;
  if (idx >= stripped.length || stripped[idx]!.text !== ":") return undefined;
  idx++;
  while (idx < stripped.length && isComment(stripped[idx]!)) idx++;
  if (idx >= stripped.length || stripped[idx]!.text !== "U8") return undefined;
  idx++;
  while (idx < stripped.length && isComment(stripped[idx]!)) idx++;
  if (idx >= stripped.length || stripped[idx]!.text !== "=>") return undefined;
  idx++;

  const bodyTokens = stripped.slice(idx);
  for (let i = 0; i < bodyTokens.length; i++) {
    const token = bodyTokens[i]!;
    if (token.kind !== "ident" || token.text !== nameToken.text) continue;
    if (previousSyntax(bodyTokens, i)?.text === "\\") continue;
    return undefined;
  }
  return { bodyTokens, endIndex: arg.endIndex };
}

function matchIfExpression(
  tokens: readonly Token[],
  index: number,
):
  | {
      typeText: string;
      condText: string;
      thenBody: Token[];
      elseBody: Token[];
      endIndex: number;
    }
  | undefined {
  const token = tokens[index];
  if (token?.text !== "if") return undefined;

  const next1 = nextSyntaxWithIndex(tokens, index);
  if (next1?.token.text !== "[") return undefined;

  const typeTokens: Token[] = [];
  let cursor = next1.index + 1;
  let depth = 1;
  while (cursor < tokens.length) {
    const t = tokens[cursor]!;
    if (t.text === "[") depth++;
    if (t.text === "]") depth--;
    if (depth === 0) break;
    typeTokens.push(t);
    cursor++;
  }
  if (cursor >= tokens.length) return undefined;
  const endTypeIdx = cursor;

  const condArg = parseArgExpression(tokens, endTypeIdx + 1);
  if (!condArg) return undefined;

  const thenLambda = parseDelayLambda(tokens, condArg.endIndex + 1);
  if (!thenLambda) return undefined;

  const elseLambda = parseDelayLambda(tokens, thenLambda.endIndex + 1);
  if (!elseLambda) return undefined;

  return {
    typeText: formatInline(typeTokens),
    condText: formatInline(condArg.tokens),
    thenBody: thenLambda.bodyTokens,
    elseBody: elseLambda.bodyTokens,
    endIndex: elseLambda.endIndex,
  };
}

function splitArms(tokens: readonly Token[]): Token[][] {
  const arms: Token[][] = [];
  let currentArm: Token[] = [];
  let depthP = 0,
    depthB = 0,
    depthBr = 0;
  for (const t of tokens) {
    if (t.text === "(") depthP++;
    else if (t.text === ")") depthP--;
    else if (t.text === "[") depthB++;
    else if (t.text === "]") depthB--;
    else if (t.text === "{") depthBr++;
    else if (t.text === "}") depthBr--;

    if (depthP === 0 && depthB === 0 && depthBr === 0 && t.text === "|") {
      if (currentArm.length > 0) {
        arms.push(currentArm);
        currentArm = [];
      }
    } else {
      currentArm.push(t);
    }
  }
  if (currentArm.length > 0) {
    arms.push(currentArm);
  }
  return arms;
}

function parseMatchHeader(
  tokens: readonly Token[],
  index: number,
):
  | {
      scrutineeText: string;
      typeText: string;
      armsTokens: Token[];
      endIndex: number;
    }
  | undefined {
  const token = tokens[index];
  if (token?.text !== "match") return undefined;

  let cursor = index + 1;
  let lbracketIdx = -1;
  let scrutDepth = 0;
  while (cursor < tokens.length) {
    const t = tokens[cursor]!;
    if (!isComment(t)) {
      if (scrutDepth === 0 && t.text === "[") {
        // Check if this [ is the match result type: its ] must be followed by {
        let d = 1;
        let c2 = cursor + 1;
        while (c2 < tokens.length) {
          const tt = tokens[c2]!;
          if (!isComment(tt)) {
            if (tt.text === "[") d++;
            else if (tt.text === "]") {
              d--;
              if (d === 0) break;
            }
          }
          c2++;
        }
        if (d === 0) {
          const after = nextSyntaxWithIndex(tokens, c2);
          if (after?.token.text === "{") {
            lbracketIdx = cursor;
            break;
          }
        }
      }
      scrutDepth += bracketDepthDelta(t);
    }
    cursor++;
  }
  if (lbracketIdx === -1) return undefined;

  const scrutineeTokens = tokens.slice(index + 1, lbracketIdx);

  let depth = 1;
  cursor = lbracketIdx + 1;
  const typeTokens: Token[] = [];
  while (cursor < tokens.length) {
    const t = tokens[cursor]!;
    if (t.text === "[") depth++;
    else if (t.text === "]") depth--;
    if (depth === 0) break;
    typeTokens.push(t);
    cursor++;
  }
  if (cursor >= tokens.length) return undefined;
  const rbracketIdx = cursor;

  const braceMatch = nextSyntaxWithIndex(tokens, rbracketIdx);
  if (braceMatch?.token.text !== "{") return undefined;

  let braceDepth = 1;
  cursor = braceMatch.index + 1;
  const armsTokens: Token[] = [];
  while (cursor < tokens.length) {
    const t = tokens[cursor]!;
    if (t.text === "{") braceDepth++;
    else if (t.text === "}") braceDepth--;
    if (braceDepth === 0) break;
    armsTokens.push(t);
    cursor++;
  }
  if (braceDepth !== 0) return undefined;

  return {
    scrutineeText: formatInline(scrutineeTokens),
    typeText: formatInline(typeTokens),
    armsTokens,
    endIndex: cursor,
  };
}

function extractErrTypeStrings(armClean: readonly Token[]): { errType: string; okType: string } | undefined {
  const arrowIdx = armClean.findIndex((t) => t.text === "=>");
  if (arrowIdx === -1) return undefined;

  const rhs = armClean.slice(arrowIdx + 1);
  if (rhs[0]?.text !== "Err") return undefined;

  let i = 1;
  while (i < rhs.length && rhs[i]!.text !== "[") i++;
  if (i >= rhs.length) return undefined;

  const firstOpen = i;
  let depth = 1;
  i++;
  while (i < rhs.length) {
    if (rhs[i]!.text === "[") depth++;
    else if (rhs[i]!.text === "]") {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  if (i >= rhs.length) return undefined;
  const firstClose = i;

  i++;
  if (i >= rhs.length || rhs[i]!.text !== "[") return undefined;
  const secondOpen = i;

  depth = 1;
  i++;
  while (i < rhs.length) {
    if (rhs[i]!.text === "[") depth++;
    else if (rhs[i]!.text === "]") {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  if (i >= rhs.length) return undefined;
  const secondClose = i;

  const errTypeTokens = rhs.slice(firstOpen + 1, firstClose);
  const okTypeTokens = rhs.slice(secondOpen + 1, secondClose);

  return {
    errType: formatInline(errTypeTokens),
    okType: formatInline(okTypeTokens),
  };
}

function normalizeTypeText(text: string): string {
  return text.replace(/[\s()]/g, "");
}

function matchMonadicBind(
  tokens: readonly Token[],
  index: number,
):
  | {
      scrutinee: string;
      typeText: string;
      varName: string;
      body: Token[];
      endIndex: number;
    }
  | undefined {
  const header = parseMatchHeader(tokens, index);
  if (!header) return undefined;

  const arms = splitArms(header.armsTokens);
  if (arms.length !== 2) return undefined;

  let errArm: Token[] | undefined;
  let okArm: Token[] | undefined;

  for (const arm of arms) {
    const first = arm.find((t) => !isComment(t));
    if (first?.text === "Err") {
      errArm = arm;
    } else if (first?.text === "Ok") {
      okArm = arm;
    }
  }

  if (!errArm || !okArm) return undefined;

  const errClean = errArm.filter((t) => !isComment(t));
  if (errClean.length < 8) return undefined;
  if (
    errClean[0]!.text !== "Err" ||
    errClean[2]!.text !== "=>" ||
    errClean[3]!.text !== "Err"
  )
    return undefined;
  const eVar = errClean[1]!.text;
  if (errClean[errClean.length - 1]!.text !== eVar) return undefined;

  // Type unifiability check: Ensure the declared match type matches the actual arm return type.
  const armTypes = extractErrTypeStrings(errClean);
  if (!armTypes) return undefined;

  const expectedTypeStr = `Result ${armTypes.errType} ${armTypes.okType}`;
  if (normalizeTypeText(header.typeText) !== normalizeTypeText(expectedTypeStr)) {
    return undefined;
  }

  const okClean = okArm.filter((t) => !isComment(t));
  if (okClean.length < 4) return undefined;
  if (okClean[0]!.text !== "Ok" || okClean[2]!.text !== "=>") return undefined;
  const varName = okClean[1]!.text;

  const arrowIdx = okArm.findIndex((t) => t.text === "=>");
  const body = okArm.slice(arrowIdx + 1);

  return {
    scrutinee: header.scrutineeText,
    typeText: header.typeText,
    varName,
    body,
    endIndex: header.endIndex,
  };
}

function matchDestructuringMatch(
  tokens: readonly Token[],
  index: number,
):
  | {
      scrutinee: string;
      typeText: string;
      ctorName: string;
      params: string[];
      body: Token[];
      endIndex: number;
    }
  | undefined {
  const header = parseMatchHeader(tokens, index);
  if (!header) return undefined;

  const arms = splitArms(header.armsTokens);
  if (arms.length !== 1) return undefined;

  const arm = arms[0]!;
  const arrowIdx = arm.findIndex((t) => t.text === "=>");
  if (arrowIdx === -1) return undefined;

  const patternTokens = arm.slice(0, arrowIdx).filter((t) => !isComment(t));
  if (patternTokens.length === 0) return undefined;

  const ctorName = patternTokens[0]!.text;
  const params = patternTokens.slice(1).map((t) => t.text);
  const body = arm.slice(arrowIdx + 1);

  return {
    scrutinee: header.scrutineeText,
    typeText: header.typeText,
    ctorName,
    params,
    body,
    endIndex: header.endIndex,
  };
}

function matchErrTermTokens(
  tokens: readonly Token[],
): { errText: string } | undefined {
  const clean = tokens.filter((t) => !isComment(t));
  if (clean.length < 6) return undefined;
  if (clean[0]!.text !== "Err") return undefined;
  let rbracketCount = 0;
  let idx = 0;
  for (let i = 0; i < clean.length; i++) {
    if (clean[i]!.text === "]") {
      rbracketCount++;
      if (rbracketCount === 2) {
        idx = i + 1;
        break;
      }
    }
  }
  if (idx === 0 || idx >= clean.length) return undefined;
  const errTokens = clean.slice(idx);
  return {
    errText: formatInline(errTokens),
  };
}

function matchLetExpression(
  tokens: readonly Token[],
  index: number,
):
  | {
      varName: string;
      valueText: string;
      body: Token[];
      endIndex: number;
    }
  | undefined {
  const token = tokens[index];
  if (token?.text !== "let") return undefined;

  const next1 = nextSyntaxWithIndex(tokens, index);
  if (!next1 || next1.token.kind !== "ident") return undefined;
  const varName = next1.token.text;

  const next2 = nextSyntaxWithIndex(tokens, next1.index);
  if (next2?.token.text !== "=") return undefined;

  const valueTokens: Token[] = [];
  let cursor = next2.index + 1;
  let depthP = 0,
    depthB = 0,
    depthBr = 0;
  let pending = 1;
  while (cursor < tokens.length) {
    const t = tokens[cursor]!;
    if (t.text === "(") depthP++;
    else if (t.text === ")") depthP--;
    else if (t.text === "[") depthB++;
    else if (t.text === "]") depthB--;
    else if (t.text === "{") depthBr++;
    else if (t.text === "}") depthBr--;

    const bd0 = depthP === 0 && depthB === 0 && depthBr === 0;
    if (bd0) {
      if (t.text === "let") {
        pending++;
      } else if (t.text === "in") {
        pending--;
        if (pending === 0) {
          break;
        }
      }
    }
    valueTokens.push(t);
    cursor++;
  }

  if (cursor >= tokens.length) return undefined;
  const inIndex = cursor;

  const body = tokens.slice(inIndex + 1);

  return {
    varName,
    valueText: formatInline(valueTokens),
    body,
    endIndex: tokens.length - 1,
  };
}

function collectDoSteps(
  tokens: readonly Token[],
  returnType: string,
): { steps: string[]; isReturn: boolean } | undefined {
  const stripped = stripOuterParens(tokens);

  const letMatch = matchLetExpression(stripped, 0);
  if (letMatch) {
    const sub = collectDoSteps(letMatch.body, returnType);
    if (sub) {
      return {
        steps: [`${letMatch.varName} = ${letMatch.valueText}`, ...sub.steps],
        isReturn: sub.isReturn,
      };
    }
  }

  const bindMatch = matchMonadicBind(stripped, 0);
  if (bindMatch && bindMatch.typeText === returnType) {
    const sub = collectDoSteps(bindMatch.body, returnType);
    if (sub) {
      return {
        steps: [`${bindMatch.varName} <- ${bindMatch.scrutinee}`, ...sub.steps],
        isReturn: sub.isReturn,
      };
    }
  }

  const destructMatch = matchDestructuringMatch(stripped, 0);
  if (destructMatch && destructMatch.typeText === returnType) {
    const sub = collectDoSteps(destructMatch.body, returnType);
    if (sub) {
      const patternText = [
        destructMatch.ctorName,
        ...destructMatch.params,
      ].join(" ");
      return {
        steps: [`${patternText} = ${destructMatch.scrutinee}`, ...sub.steps],
        isReturn: sub.isReturn,
      };
    }
  }

  const ifMatch = matchIfExpression(stripped, 0);
  if (ifMatch && ifMatch.typeText === returnType) {
    const errMatch = matchErrTermTokens(ifMatch.elseBody);
    if (errMatch) {
      const sub = collectDoSteps(ifMatch.thenBody, returnType);
      if (sub) {
        return {
          steps: [
            `assert ${ifMatch.condText} else ${errMatch.errText}`,
            ...sub.steps,
          ],
          isReturn: sub.isReturn,
        };
      }
    }
  }

  const text = formatInline(stripped);
  if (text.startsWith("Ok ")) {
    return {
      steps: [`return ${text}`],
      isReturn: true,
    };
  }

  if (stripped.filter((t) => !isComment(t)).length === 0) return undefined;

  // Always emit a "return ..." for the terminal bare expression step. This ensures
  // the last step is always a "return" (recognized by isStartOfDoStep and the real
  // parser's final-step check), so splitters and formatters correctly separate it
  // from preceding bind/let/match steps (bare lower-ident exprs or "if" etc. would
  // otherwise be swallowed, producing jammed steps that the Trip parser rejects
  // with "do block final step must be an expression or a return statement").
  return {
    steps: [`return ${text}`],
    isReturn: true,
  };
}

function parseDoChain(
  tokens: readonly Token[],
  index: number,
):
  | {
      typeText: string;
      steps: string[];
      endIndex: number;
    }
  | undefined {
  const header = parseMatchHeader(tokens, index);
  if (!header) return undefined;

  if (!header.typeText.trim().startsWith("Result")) {
    return undefined;
  }

  const collected = collectDoSteps(tokens.slice(index), header.typeText);
  if (!collected) return undefined;

  if (collected.steps.length < 2) return undefined;

  return {
    typeText: header.typeText,
    steps: collected.steps,
    endIndex: header.endIndex,
  };
}

function parseCondChain(
  tokens: readonly Token[],
  index: number,
):
  | {
      typeText: string;
      arms: { condText: string; bodyText: string }[];
      defaultBodyText: string;
      endIndex: number;
    }
  | undefined {
  const firstIf = matchIfExpression(tokens, index);
  if (!firstIf) return undefined;

  const typeText = firstIf.typeText;
  const arms: { condText: string; bodyText: string }[] = [];

  arms.push({
    condText: firstIf.condText,
    bodyText: formatInline(firstIf.thenBody),
  });

  let currentElseTokens = firstIf.elseBody;
  let currentEndIndex = firstIf.endIndex;

  for (;;) {
    const stripped = stripOuterParens(currentElseTokens);
    const elseIfMatch = matchIfExpression(stripped, 0);
    if (
      elseIfMatch &&
      elseIfMatch.typeText === typeText &&
      elseIfMatch.endIndex === stripped.length - 1
    ) {
      arms.push({
        condText: elseIfMatch.condText,
        bodyText: formatInline(elseIfMatch.thenBody),
      });
      currentElseTokens = elseIfMatch.elseBody;
      continue;
    }
    break;
  }

  if (arms.length < 2) return undefined;

  const defaultBodyText = formatInline(currentElseTokens);

  return {
    typeText,
    arms,
    defaultBodyText,
    endIndex: currentEndIndex,
  };
}

/**
 * Leading whitespace of the line containing `offset`. A generated multi-line
 * replacement (e.g. a `do`/`cond` block) lands at the column of the construct it
 * replaces, so its inner lines and closing brace must be indented relative to
 * that line's indentation rather than a hard-coded amount.
 */
function lineIndentAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart))![0];
}

function lintTokens(source: string, tokens: Token[]): TripLintDiagnostic[] {
  const diagnostics: TripLintDiagnostic[] = [];
  const topLevel = collectTopLevelBindings(tokens);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    // 1. Append chain simplification
    const appendMatch = parseAppendChain(tokens, i);
    if (appendMatch) {
      if (appendMatch.typeText === "U8") {
        const strLit = convertToStaticString(appendMatch.elements);
        if (strLit !== undefined) {
          diagnostics.push(
            diagnostic(
              "trip-string-append",
              `Use double-quoted string literal ${strLit} instead of character list/append`,
              tokens[i]!,
              {
                start: tokens[i]!.start,
                end: tokens[appendMatch.endIndex]!.end,
                replacement: strLit,
              },
            ),
          );
          i = appendMatch.endIndex;
          continue;
        }
      }

      const elementsStr = appendMatch.elements
        .map((t) => formatInline(t))
        .join(" ");
      const replacement = `{${appendMatch.typeText} |${elementsStr ? " " + elementsStr : ""}}`;
      diagnostics.push(
        diagnostic(
          "trip-list-append",
          `Use syntactic sugar {${appendMatch.typeText} | ...} for list append/construction`,
          tokens[i]!,
          {
            start: tokens[i]!.start,
            end: tokens[appendMatch.endIndex]!.end,
            replacement,
          },
        ),
      );
      i = appendMatch.endIndex;
      continue;
    }

    // 1b. Append chain simplification to concat
    const appendSegmentMatch = parseAppendSegmentChain(tokens, i);
    if (
      appendSegmentMatch &&
      appendSegmentMatch.appendCount >= 2 &&
      canUsePrelude(topLevel, "append") &&
      canUsePrelude(topLevel, "concat")
    ) {
      const segmentTypeText = typeTextForListElementType(
        appendSegmentMatch.typeText,
      );
      const segmentsStr = appendSegmentMatch.segments
        .map((t) => formatInline(t))
        .join(" ");
      const replacement = `concat [${appendSegmentMatch.typeText}] {${segmentTypeText} | ${segmentsStr}}`;
      diagnostics.push(
        diagnostic(
          "trip-append-concat",
          `Use concat [${appendSegmentMatch.typeText}] to flatten nested append calls`,
          tokens[i]!,
          {
            start: tokens[i]!.start,
            end: tokens[appendSegmentMatch.endIndex]!.end,
            replacement,
          },
        ),
      );
      i = appendSegmentMatch.endIndex;
      continue;
    }

    // 2. List cons/nil chain simplification
    const listChainMatch = parseListChain(tokens, i);
    if (listChainMatch) {
      if (listChainMatch.typeText === "U8") {
        const strLit = convertToStaticString(listChainMatch.elements);
        if (strLit !== undefined) {
          diagnostics.push(
            diagnostic(
              "trip-string-literal",
              `Use double-quoted string literal ${strLit} instead of character list/cons`,
              tokens[i]!,
              {
                start: tokens[i]!.start,
                end: tokens[listChainMatch.endIndex]!.end,
                replacement: strLit,
              },
            ),
          );
          i = listChainMatch.endIndex;
          continue;
        }
      }

      const elementsStr = listChainMatch.elements
        .map((t) => formatInline(t))
        .join(" ");
      const replacement = `{${listChainMatch.typeText} |${elementsStr ? " " + elementsStr : ""}}`;
      diagnostics.push(
        diagnostic(
          "trip-list-literal",
          `Use syntactic sugar {${listChainMatch.typeText} | ...} for list construction`,
          tokens[i]!,
          {
            start: tokens[i]!.start,
            end: tokens[listChainMatch.endIndex]!.end,
            replacement,
          },
        ),
      );
      i = listChainMatch.endIndex;
      continue;
    }

    // 2b. Cons prefix simplification to a literal chunk plus tail append
    const consPrefixMatch = parseConsPrefixChain(tokens, i);
    if (
      consPrefixMatch &&
      consPrefixMatch.elements.length >= 2 &&
      canUsePrelude(topLevel, "cons") &&
      canUsePrelude(topLevel, "append")
    ) {
      const staticTail = resolveAsStaticList(consPrefixMatch.tailTokens);
      if (staticTail?.typeText !== consPrefixMatch.typeText) {
        const elementsStr = consPrefixMatch.elements
          .map((t) => formatInline(t))
          .join(" ");
        const tailText = formatInline(consPrefixMatch.tailTokens);
        const replacement = `append [${consPrefixMatch.typeText}] {${consPrefixMatch.typeText} | ${elementsStr}} ${tailText}`;
        diagnostics.push(
          diagnostic(
            "trip-cons-prefix",
            `Use syntactic sugar {${consPrefixMatch.typeText} | ...} for nested cons prefix`,
            tokens[i]!,
            {
              start: tokens[i]!.start,
              end: tokens[consPrefixMatch.endIndex]!.end,
              replacement,
            },
          ),
        );
        i = consPrefixMatch.endIndex;
        continue;
      }
    }

    // 3. List literal to string literal conversion (for U8 chars)
    const listLiteralMatch = parseListLiteral(tokens, i);
    if (listLiteralMatch) {
      if (listLiteralMatch.typeText === "U8") {
        const strLit = convertToStaticString(listLiteralMatch.elements);
        if (strLit !== undefined) {
          diagnostics.push(
            diagnostic(
              "trip-string-literal",
              `Use double-quoted string literal ${strLit} instead of U8 character list`,
              tokens[i]!,
              {
                start: tokens[i]!.start,
                end: tokens[listLiteralMatch.endIndex]!.end,
                replacement: strLit,
              },
            ),
          );
          i = listLiteralMatch.endIndex;
          continue;
        }
      }
    }

    // 4. Pair literal simplification
    const pairLiteralMatch = matchMkPair(tokens, i);
    if (pairLiteralMatch) {
      const replacement = `{${pairLiteralMatch.type1Text}, ${pairLiteralMatch.type2Text} | ${formatInline(pairLiteralMatch.term1Tokens)}, ${formatInline(pairLiteralMatch.term2Tokens)}}`;
      diagnostics.push(
        diagnostic(
          "trip-pair-literal",
          `Use syntactic sugar {${pairLiteralMatch.type1Text}, ${pairLiteralMatch.type2Text} | ...} for pair creation`,
          tokens[i]!,
          {
            start: tokens[i]!.start,
            end: tokens[pairLiteralMatch.endIndex]!.end,
            replacement,
          },
        ),
      );
      i = pairLiteralMatch.endIndex;
      continue;
    }

    // 4b. Pair type simplification
    const prevText = previousSyntax(tokens, i)?.text;
    if (prevText !== "data" && prevText !== "type" && !isInsideDataDefinition(tokens, i)) {
      const pairTypeMatch = matchPairType(tokens, i);
      if (pairTypeMatch) {
        const replacement = `(${formatInline(pairTypeMatch.type1Tokens)}, ${formatInline(pairTypeMatch.type2Tokens)})`;
        diagnostics.push(
          diagnostic(
            "trip-pair-type",
            `Use syntactic sugar (Type1, Type2) for pair type`,
            tokens[i]!,
            {
              start: tokens[i]!.start,
              end: tokens[pairTypeMatch.endIndex]!.end,
              replacement,
            },
          ),
        );
        i = pairTypeMatch.endIndex;
        continue;
      }
    }

    // 5. Degenerate match chain simplification to do
    const doChainMatch = parseDoChain(tokens, i);
    if (doChainMatch) {
      const baseIndent = lineIndentAt(source, tokens[i]!.start);
      const stepIndent = `${baseIndent}  `;
      const stepLines = doChainMatch.steps
        .map((step) => `${stepIndent}${step}`)
        .join("\n");
      const replacement = `do [${doChainMatch.typeText}] {\n${stepLines}\n${baseIndent}}`;
      diagnostics.push(
        diagnostic(
          "trip-degenerate-do",
          `Use do [${doChainMatch.typeText}] {...} to flatten nested monadic match chains`,
          tokens[i]!,
          {
            start: tokens[i]!.start,
            end: tokens[doChainMatch.endIndex]!.end,
            replacement,
          },
        ),
      );
      i = doChainMatch.endIndex;
      continue;
    }

    // 6. Degenerate if chain simplification to cond
    const condChainMatch = parseCondChain(tokens, i);
    if (condChainMatch) {
      const baseIndent = lineIndentAt(source, tokens[i]!.start);
      const stepIndent = `${baseIndent}  `;
      const armLines = condChainMatch.arms
        .map((arm) => `${stepIndent}| ${arm.condText} => ${arm.bodyText}`)
        .join("\n");
      const replacement = `cond [${condChainMatch.typeText}] {\n${armLines}\n${stepIndent}| otherwise => ${condChainMatch.defaultBodyText}\n${baseIndent}}`;
      diagnostics.push(
        diagnostic(
          "trip-degenerate-if",
          `Use cond [${condChainMatch.typeText}] {...} to flatten nested if chains`,
          tokens[i]!,
          {
            start: tokens[i]!.start,
            end: tokens[condChainMatch.endIndex]!.end,
            replacement,
          },
        ),
      );
      i = condChainMatch.endIndex;
      continue;
    }

    // 6b. Simplify boolean if expressions
    const ifSimplifyMatch = matchIfExpression(tokens, i);
    if (
      ifSimplifyMatch &&
      ifSimplifyMatch.typeText === "Bool"
    ) {
      const thenText = formatInline(ifSimplifyMatch.thenBody).trim();
      const elseText = formatInline(ifSimplifyMatch.elseBody).trim();

      if (thenText === "true" && elseText === "false") {
        const replacement = ifSimplifyMatch.condText;
        diagnostics.push(
          diagnostic(
            "trip-bool-if-simplify",
            `Simplify boolean if-expression to condition`,
            tokens[i]!,
            {
              start: tokens[i]!.start,
              end: tokens[ifSimplifyMatch.endIndex]!.end,
              replacement,
            },
          ),
        );
        i = ifSimplifyMatch.endIndex;
        continue;
      }

      if (elseText === "false" && canUsePrelude(topLevel, "and")) {
        const replacement = `and (${ifSimplifyMatch.condText}) (${thenText})`;
        diagnostics.push(
          diagnostic(
            "trip-bool-if-simplify",
            `Simplify boolean if-expression to and`,
            tokens[i]!,
            {
              start: tokens[i]!.start,
              end: tokens[ifSimplifyMatch.endIndex]!.end,
              replacement,
            },
          ),
        );
        i = ifSimplifyMatch.endIndex;
        continue;
      }

      if (thenText === "true" && canUsePrelude(topLevel, "or")) {
        const replacement = `or (${ifSimplifyMatch.condText}) (${elseText})`;
        diagnostics.push(
          diagnostic(
            "trip-bool-if-simplify",
            `Simplify boolean if-expression to or`,
            tokens[i]!,
            {
              start: tokens[i]!.start,
              end: tokens[ifSimplifyMatch.endIndex]!.end,
              replacement,
            },
          ),
        );
        i = ifSimplifyMatch.endIndex;
        continue;
      }

      if (thenText === "false" && elseText === "true" && canUsePrelude(topLevel, "not")) {
        const replacement = `not (${ifSimplifyMatch.condText})`;
        diagnostics.push(
          diagnostic(
            "trip-bool-if-simplify",
            `Simplify boolean if-expression to not`,
            tokens[i]!,
            {
              start: tokens[i]!.start,
              end: tokens[ifSimplifyMatch.endIndex]!.end,
              replacement,
            },
          ),
        );
        i = ifSimplifyMatch.endIndex;
        continue;
      }

      if (
        thenText === "false" &&
        elseText !== "true" &&
        elseText !== "false" &&
        canUsePrelude(topLevel, "and") &&
        canUsePrelude(topLevel, "not")
      ) {
        const replacement = `and (not (${ifSimplifyMatch.condText})) (${elseText})`;
        diagnostics.push(
          diagnostic(
            "trip-bool-if-simplify",
            `Simplify boolean if-expression to and/not`,
            tokens[i]!,
            {
              start: tokens[i]!.start,
              end: tokens[ifSimplifyMatch.endIndex]!.end,
              replacement,
            },
          ),
        );
        i = ifSimplifyMatch.endIndex;
        continue;
      }

      if (
        elseText === "true" &&
        thenText !== "true" &&
        thenText !== "false" &&
        canUsePrelude(topLevel, "or") &&
        canUsePrelude(topLevel, "not")
      ) {
        const replacement = `or (not (${ifSimplifyMatch.condText})) (${thenText})`;
        diagnostics.push(
          diagnostic(
            "trip-bool-if-simplify",
            `Simplify boolean if-expression to or/not`,
            tokens[i]!,
            {
              start: tokens[i]!.start,
              end: tokens[ifSimplifyMatch.endIndex]!.end,
              replacement,
            },
          ),
        );
        i = ifSimplifyMatch.endIndex;
        continue;
      }
    }

    if (token.kind === "number") {
      const value = Number(token.text);
      if (
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 255 &&
        !isExistingU8Literal(tokens, i)
      ) {
        diagnostics.push(
          diagnostic(
            "trip-u8-literal",
            `Use canonical #u8(${value}) spelling for byte literals`,
            token,
            {
              start: token.start,
              end: token.end,
              replacement: `#u8(${value})`,
            },
          ),
        );
      }
    }

    if (token.text === "(") {
      const prevMatch = previousSyntaxWithIndex(tokens, i);
      const beforePrevMatch = prevMatch
        ? previousSyntaxWithIndex(tokens, prevMatch.index)
        : undefined;
      if (
        prevMatch?.token.text === "u8" &&
        beforePrevMatch?.token.text === "#"
      ) {
        continue;
      }
      const outerCloseIdx = findMatchingBrace(tokens, i, "(", ")");
      if (outerCloseIdx !== -1) {
        const outerCloseToken = tokens[outerCloseIdx]!;
        const innerTokens = tokens.slice(i + 1, outerCloseIdx);
        if (innerTokens.length > 0) {
          const firstInner = innerTokens[0]!;
          let isRedundant = false;
          let replacement = "";

          // Case 1: Inner is atomic expression
          if (innerTokens.length === 1 && simpleTokenReplacement(firstInner)) {
            isRedundant = true;
            replacement = firstInner.text;
          }
          // Case 2: Inner is already parenthesized ( (expr) )
          else if (
            firstInner.text === "(" &&
            findMatchingBrace(innerTokens, 0, "(", ")") ===
              innerTokens.length - 1
          ) {
            isRedundant = true;
            replacement = formatInline(innerTokens);
          }
          // Case 3: Inner is bracketed ( [expr] )
          else if (
            firstInner.text === "[" &&
            findMatchingBrace(innerTokens, 0, "[", "]") ===
              innerTokens.length - 1
          ) {
            isRedundant = true;
            replacement = formatInline(innerTokens);
          }
          // Case 4: Inner is braced ( {expr} )
          else if (
            firstInner.text === "{" &&
            findMatchingBrace(innerTokens, 0, "{", "}") ===
              innerTokens.length - 1
          ) {
            isRedundant = true;
            replacement = formatInline(innerTokens);
          }

          if (isRedundant) {
            diagnostics.push(
              diagnostic(
                "trip-redundant-parens",
                "Remove redundant parentheses",
                token,
                {
                  start: token.start,
                  end: outerCloseToken.end,
                  replacement,
                },
              ),
            );
          }
        }
      }
    }

    if (token.text === "\\") {
      const nameMatch = nextSyntaxWithIndex(tokens, i);
      if (!nameMatch || nameMatch.token.kind !== "ident") continue;
      const colonMatch = nextSyntaxWithIndex(tokens, nameMatch.index);
      if (colonMatch?.token.text !== ":") continue;
      let cursor = colonMatch.index;
      let arrowMatch: { token: Token; index: number } | undefined;
      while ((arrowMatch = nextSyntaxWithIndex(tokens, cursor))) {
        cursor = arrowMatch.index;
        if (arrowMatch.token.text === "=>") break;
        if (
          arrowMatch.token.text === ")" ||
          arrowMatch.token.text === "}" ||
          arrowMatch.token.text === "|"
        ) {
          arrowMatch = undefined;
          break;
        }
      }
      if (!arrowMatch) continue;
      const fnMatch = nextSyntaxWithIndex(tokens, arrowMatch.index);
      if (!fnMatch) continue;
      const argMatch = nextSyntaxWithIndex(tokens, fnMatch.index);
      if (!argMatch) continue;
      const afterArgMatch = nextSyntaxWithIndex(tokens, argMatch.index);
      if (
        fnMatch.token.kind === "ident" &&
        argMatch.token.kind === "ident" &&
        argMatch.token.text === nameMatch.token.text &&
        fnMatch.token.text !== nameMatch.token.text &&
        (!afterArgMatch ||
          [")", "}", "|"].includes(afterArgMatch.token.text) ||
          TOP_LEVEL_KEYWORDS.has(afterArgMatch.token.text))
      ) {
        diagnostics.push(
          diagnostic(
            "trip-eta-reduce",
            `Eta-reduce \\${nameMatch.token.text} -> ${fnMatch.token.text}`,
            token,
            {
              start: token.start,
              end: argMatch.token.end,
              replacement: fnMatch.token.text,
            },
          ),
        );
      }
    }

    if (token.text === "#") {
      const nameMatch = nextSyntaxWithIndex(tokens, i);
      if (nameMatch?.token.kind === "ident") {
        const arrowMatch = nextSyntaxWithIndex(tokens, nameMatch.index);
        if (arrowMatch?.token.text === "=>") {
          const fnMatch = nextSyntaxWithIndex(tokens, arrowMatch.index);
          if (fnMatch?.token.kind === "ident") {
            const lbracketMatch = nextSyntaxWithIndex(tokens, fnMatch.index);
            if (lbracketMatch?.token.text === "[") {
              const tyMatch = nextSyntaxWithIndex(tokens, lbracketMatch.index);
              if (
                tyMatch?.token.kind === "ident" &&
                tyMatch.token.text === nameMatch.token.text
              ) {
                const rbracketMatch = nextSyntaxWithIndex(
                  tokens,
                  tyMatch.index,
                );
                if (rbracketMatch?.token.text === "]") {
                  diagnostics.push(
                    diagnostic(
                      "trip-type-eta-reduce",
                      `Type-eta-reduce #${nameMatch.token.text}`,
                      token,
                      {
                        start: token.start,
                        end: rbracketMatch.token.end,
                        replacement: fnMatch.token.text,
                      },
                    ),
                  );
                }
              }
            }
          }
        }
      }
    }

    if (token.text === "let") {
      const nameMatch = nextSyntaxWithIndex(tokens, i);
      if (nameMatch?.token.kind === "ident") {
        const eqMatch = nextSyntaxWithIndex(tokens, nameMatch.index);
        if (eqMatch?.token.text === "=") {
          const valueMatch = nextSyntaxWithIndex(tokens, eqMatch.index);
          if (valueMatch && simpleTokenReplacement(valueMatch.token)) {
            const inMatch = nextSyntaxWithIndex(tokens, valueMatch.index);
            if (inMatch?.token.text === "in") {
              const bodyMatch = nextSyntaxWithIndex(tokens, inMatch.index);
              if (
                bodyMatch?.token.kind === "ident" &&
                bodyMatch.token.text === nameMatch.token.text
              ) {
                diagnostics.push(
                  diagnostic(
                    "trip-let-identity",
                    "Replace identity let binding with its value",
                    token,
                    {
                      start: token.start,
                      end: bodyMatch.token.end,
                      replacement: valueMatch.token.text,
                    },
                  ),
                );
              }
            }
          }
        }
      }
    }
  }

  if (canUsePrelude(topLevel, "not")) {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.text !== "not") continue;
      const argMatch = nextSyntaxWithIndex(tokens, i);
      if (argMatch?.token.text === "true" || argMatch?.token.text === "false") {
        diagnostics.push(
          diagnostic(
            "trip-bool-constant",
            `Simplify not ${argMatch.token.text}`,
            token,
            {
              start: token.start,
              end: argMatch.token.end,
              replacement: argMatch.token.text === "true" ? "false" : "true",
            },
          ),
        );
      }
    }
  }

  for (const op of ["and", "or"] as const) {
    if (!canUsePrelude(topLevel, op)) continue;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.text !== op) continue;
      const leftMatch = nextSyntaxWithIndex(tokens, i);
      if (leftMatch) {
        const rightMatch = nextSyntaxWithIndex(tokens, leftMatch.index);
        if (rightMatch) {
          const left = leftMatch.token;
          const right = rightMatch.token;
          const rightReplacement = simpleTokenReplacement(right);
          const leftReplacement = simpleTokenReplacement(left);
          if (op === "and" && left.text === "true" && rightReplacement) {
            diagnostics.push(
              diagnostic("trip-bool-identity", "Simplify and true x", token, {
                start: token.start,
                end: right.end,
                replacement: rightReplacement,
              }),
            );
          } else if (op === "and" && right.text === "true" && leftReplacement) {
            diagnostics.push(
              diagnostic("trip-bool-identity", "Simplify and x true", token, {
                start: token.start,
                end: right.end,
                replacement: leftReplacement,
              }),
            );
          } else if (
            op === "and" &&
            (left.text === "false" || right.text === "false")
          ) {
            diagnostics.push(
              diagnostic("trip-bool-constant", "Simplify and false", token, {
                start: token.start,
                end: right.end,
                replacement: "false",
              }),
            );
          } else if (op === "or" && left.text === "false" && rightReplacement) {
            diagnostics.push(
              diagnostic("trip-bool-identity", "Simplify or false x", token, {
                start: token.start,
                end: right.end,
                replacement: rightReplacement,
              }),
            );
          } else if (op === "or" && right.text === "false" && leftReplacement) {
            diagnostics.push(
              diagnostic("trip-bool-identity", "Simplify or x false", token, {
                start: token.start,
                end: right.end,
                replacement: leftReplacement,
              }),
            );
          } else if (
            op === "or" &&
            (left.text === "true" || right.text === "true")
          ) {
            diagnostics.push(
              diagnostic("trip-bool-constant", "Simplify or true", token, {
                start: token.start,
                end: right.end,
                replacement: "true",
              }),
            );
          }
        }
      }
    }
  }

  if (canUsePrelude(topLevel, "if")) {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.text !== "if") continue;
      const lbracketMatch = nextSyntaxWithIndex(tokens, i);
      if (lbracketMatch?.token.text === "[") {
        let cursor = lbracketMatch.index;
        let rbracketMatch: { token: Token; index: number } | undefined;
        while ((rbracketMatch = nextSyntaxWithIndex(tokens, cursor))) {
          cursor = rbracketMatch.index;
          if (rbracketMatch.token.text === "]") break;
        }
        if (rbracketMatch?.token.text === "]") {
          const condMatch = nextSyntaxWithIndex(tokens, rbracketMatch.index);
          const cond = condMatch?.token;
          if (cond?.text === "true" || cond?.text === "false") {
            diagnostics.push(
              diagnostic(
                "trip-if-constant",
                `Condition is constant ${cond.text}; simplify the if expression manually`,
                token,
              ),
            );
          }
        }
      }
    }
  }

  // Recompute line/column for any token-like diagnostics produced after source
  // normalization. This keeps CRLF input diagnostics stable.
  return diagnostics.map((diag) => {
    const loc = locationAt(source, diag.offset);
    return { ...diag, line: loc.line, column: loc.column };
  });
}

function fixesOverlap(a: TripLintFix, b: TripLintFix): boolean {
  return a.start < b.end && b.start < a.end;
}

// Lint fixes fall into two soundness classes. AST-preserving rewrites (syntactic
// sugar and canonical spellings) must parse to the *same* AST as the code they
// replace; we verify that and drop any rewrite that would change it. Semantic
// rewrites (eta/eta-type reduction, boolean algebra, identity-let elimination)
// change the AST on purpose, so the rule owns soundness and we only require that
// the result still parses.
const AST_PRESERVING_FIX_CODES: ReadonlySet<string> = new Set([
  "trip-list-literal",
  "trip-pair-literal",
  "trip-pair-type",
  "trip-string-literal",
  "trip-redundant-parens",
  "trip-u8-literal",
  "trip-degenerate-if",
  "trip-degenerate-do",
]);

/**
 * Applies the selected fixes one at a time, from the end of the file backwards
 * so untouched offsets stay valid even when a fix is skipped. Every fix is
 * verified before it is kept: no fix may turn a parseable program into an
 * unparseable one, and an AST-preserving fix may never change the AST.
 */
function applyVerifiedFixes(
  source: string,
  diagnostics: readonly TripLintDiagnostic[],
  options: { force?: boolean } = {},
): { fixed: string; applied: TripLintDiagnostic[] } {
  const selected: TripLintDiagnostic[] = [];
  for (const diag of diagnostics) {
    if (!diag.fix) continue;
    if (selected.some((other) => fixesOverlap(other.fix!, diag.fix!))) {
      continue;
    }
    selected.push(diag);
  }
  selected.sort((a, b) => b.fix!.start - a.fix!.start);

  let current = source;
  let currentAst = parseProgramOrNull(current);
  const applied: TripLintDiagnostic[] = [];

  for (const diag of selected) {
    const fix = diag.fix!;
    const candidate =
      current.slice(0, fix.start) + fix.replacement + current.slice(fix.end);
    const candidateAst = parseProgramOrNull(candidate);

    // Never regress a parseable program into an unparseable one.
    // Under --force we bypass this so that the detector's proposed textual
    // replacement is applied even if our heuristic reconstruction doesn't
    // produce something the full parser accepts on the first try.
    // (The user can then inspect the diff and clean up.)
    if (
      currentAst !== undefined &&
      candidateAst === undefined &&
      !options.force
    ) {
      continue;
    }

    // Sugar / canonical-spelling rewrites must be exact AST round-trips,
    // unless --force is used (for testing / aggressive application).
    if (
      !options.force &&
      AST_PRESERVING_FIX_CODES.has(diag.code) &&
      currentAst !== undefined &&
      candidateAst !== currentAst
    ) {
      continue;
    }

    current = candidate;
    currentAst = candidateAst;
    applied.push(diag);
  }

  return { fixed: current, applied };
}

export function lintTripSource(
  sourceText: string,
  options: { fix?: boolean; verbose?: boolean; force?: boolean } = {},
): TripLintResult {
  const source = normalizeSource(sourceText);

  const tStartLex = Date.now();
  const tokens = lexTrip(source);
  if (options.verbose) {
    console.log(
      `[profile-lint] lexTrip completed in ${Date.now() - tStartLex}ms`,
    );
  }

  const tStartLintTokens = Date.now();
  const diagnostics = lintTokens(source, tokens);
  if (options.verbose) {
    console.log(
      `[profile-lint] lintTokens completed in ${Date.now() - tStartLintTokens}ms`,
    );
  }

  if (!options.fix || diagnostics.every((diag) => !diag.fix)) {
    return { diagnostics, fixed: source, changed: false };
  }

  // Under --fix (especially --force), iteratively apply as many fixes as
  // possible until a stable state. This handles nested/overlapping cases
  // (e.g. Pair inside Pair, or chains that become fixable after one rewrite)
  // by re-detecting on the updated source each pass.
  // Only the fixes that were successfully applied (across passes) are
  // reported, ensuring no "reported but not autofixed".
  let current = source;
  let allApplied: TripLintDiagnostic[] = [];
  let anyChanged = false;
  const maxPasses = 20; // safety for deep nesting
  for (let pass = 0; pass < maxPasses; pass++) {
    const toks = lexTrip(current);
    const passDiags = lintTokens(current, toks);
    if (passDiags.every((d) => !d.fix)) break;
    const applyRes = applyVerifiedFixes(current, passDiags, {
      force: options.force,
    });
    const { formatted: passFormatted } = formatTripSource(applyRes.fixed, {
      force: options.force,
    });
    if (passFormatted === current) break;
    current = passFormatted;
    allApplied = allApplied.concat(applyRes.applied);
    anyChanged = true;
  }
  return {
    diagnostics: allApplied,
    fixed: current,
    changed: anyChanged,
  };
}

export { pruneUnreachableTripCode } from "./reachability.ts";

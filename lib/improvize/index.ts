import { stat, readdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { parseTripLang } from "../parser/tripLang.ts";
import { scanTrip, type ScanKind, type ScanToken } from "./lexer.ts";
import {
  KneserNeyLM,
  getTrainedLMSync,
  getStatisticalDiagnostics,
} from "./statistical.ts";
export { getTrainedLMSync };

type TokenKind = Exclude<ScanKind, "space" | "newline">;

interface Token extends Omit<ScanToken, "kind"> {
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

function lexTrip(sourceText: string): Token[] {
  const source = normalizeSource(sourceText);
  if (!isAscii(source)) {
    throw new Error("improvize only accepts ASCII Trip source");
  }

  return scanTrip(source, true).filter(isSyntaxToken);
}

function isComment(token: Token): boolean {
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
  cwd = process.cwd(),
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

function partitionDecls(tokens: readonly Token[]): Token[][] {
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

export function formatTripSource(source: string): TripFormatResult {
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
  const before = parseProgramOrNull(normalized);
  if (before !== undefined && parseProgramOrNull(formatted) !== before) {
    return { formatted: normalized, changed: false };
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

  return {
    type1Tokens: type1.tokens,
    type2Tokens: type2.tokens,
    endIndex: type2.endIndex,
  };
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

    // 5. Pair type simplification
    const prevText = previousSyntax(tokens, i)?.text;
    if (prevText !== "data" && prevText !== "type") {
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
      const atomMatch = nextSyntaxWithIndex(tokens, i);
      if (atomMatch) {
        const closeMatch = nextSyntaxWithIndex(tokens, atomMatch.index);
        if (
          closeMatch?.token.text === ")" &&
          simpleTokenReplacement(atomMatch.token)
        ) {
          diagnostics.push(
            diagnostic(
              "trip-redundant-parens",
              "Remove redundant parentheses around an atomic expression",
              token,
              {
                start: token.start,
                end: closeMatch.token.end,
                replacement: atomMatch.token.text,
              },
            ),
          );
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
  "trip-formatting-deviation",
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
): string {
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

  for (const diag of selected) {
    const fix = diag.fix!;
    const candidate =
      current.slice(0, fix.start) + fix.replacement + current.slice(fix.end);
    const candidateAst = parseProgramOrNull(candidate);

    // Never regress a parseable program into an unparseable one.
    if (currentAst !== undefined && candidateAst === undefined) {
      continue;
    }
    // Sugar / canonical-spelling rewrites must be exact AST round-trips.
    if (
      AST_PRESERVING_FIX_CODES.has(diag.code) &&
      currentAst !== undefined &&
      candidateAst !== currentAst
    ) {
      continue;
    }

    current = candidate;
    currentAst = candidateAst;
  }

  return current;
}

export function lintTripSource(
  sourceText: string,
  options: { fix?: boolean; lm?: KneserNeyLM; verbose?: boolean } = {},
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

  const tStartTrainLM = Date.now();
  const lm = options.lm || getTrainedLMSync();
  if (options.verbose) {
    console.log(
      `[profile-lint] getTrainedLMSync completed in ${Date.now() - tStartTrainLM}ms`,
    );
  }

  const tStartStats = Date.now();
  const statDiagnostics = getStatisticalDiagnostics(source, lm);
  if (options.verbose) {
    console.log(
      `[profile-lint] getStatisticalDiagnostics completed in ${Date.now() - tStartStats}ms`,
    );
  }
  diagnostics.push(...statDiagnostics);

  if (!options.fix || diagnostics.every((diag) => !diag.fix)) {
    return { diagnostics, fixed: source, changed: false };
  }

  // Apply only the fixes that pass per-fix verification, then format. The
  // formatter is itself AST-preserving (see formatTripSource), so the final
  // output differs from `source` only by verified, meaning-preserving edits.
  const fixed = applyVerifiedFixes(source, diagnostics);
  const { formatted } = formatTripSource(fixed);
  return {
    diagnostics,
    fixed: formatted,
    changed: formatted !== source,
  };
}

export function lintAndFormatTripSource(source: string): TripLintResult {
  return lintTripSource(formatTripSource(source).formatted, { fix: false });
}

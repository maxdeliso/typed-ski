/**
 * System F term parser.
 *
 * This module provides parsing functionality for System F (polymorphic lambda calculus)
 * terms, including variables, abstractions, type abstractions, and applications.
 *
 * Arrow Syntax:
 * - Type arrows use "->": "T -> U" means function type from T to U
 * - Term arrows use "=>": "\\x => body" or "match x { | C => body }"
 *   Match arms specifically use "=>" (fat arrow), not "->" (skinny arrow)
 *
 * Uses consistent Recursive Descent; precedence is handled via: Atom < App < Term.
 *
 * @module
 */
import { ParseError } from "./parseError.ts";
import {
  isAtDefinitionKeywordLine,
  isDigit,
  matchCh,
  matchFatArrow,
  matchLP,
  matchRP,
  parseIdentifier,
  parseNumericLiteral,
  peek,
  peekFatArrow,
  skipWhitespace,
  withParserState,
} from "./parserState.ts";
import type { ParserState } from "./parserState.ts";
import type { BaseType } from "../types/types.ts";
import { parseSystemFType } from "./systemFType.ts";
import { parseWithEOF } from "./eof.ts";
import {
  mkSystemFAbs,
  mkSystemFTAbs,
  mkSystemFTypeApp,
  mkSystemFVar,
  type SystemFMatchArm,
  type SystemFTerm,
} from "../terms/systemF.ts";
import { makeNatLiteralIdentifier, makeNatType } from "../consts/nat.ts";
import {
  createSystemFApplication,
  flattenSystemFApp,
} from "../terms/systemF.ts";
import {
  BACKSLASH,
  COLON,
  EQUALS,
  FAT_ARROW,
  HASH,
  LEFT_BRACE,
  LEFT_PAREN,
  RIGHT_BRACE,
  RIGHT_PAREN,
} from "./consts.ts";
import { parseNatLiteralIdentifier } from "../consts/natNames.ts";
import { unparseSystemFType } from "./systemFType.ts";

/**
 * Checks if the upcoming token should terminate a chain of applications.
 * An application chain (e.g., `f x y`) stops if we see:
 * - A closing parenthesis/brace/bracket: `)`, `}`, `]`
 * - A match arm delimiter: `|`
 * - The start of a match block: `{`
 * - A keyword that starts a new structure: `in` (for let)
 * - The start of a new definition line
 */
function isTerminator(state: ParserState): boolean {
  const [ch, _] = peek(state);

  if (ch === null) return true;
  if (isAtDefinitionKeywordLine(state)) return true;

  // Structural delimiters
  if (
    ch === RIGHT_PAREN || ch === RIGHT_BRACE || ch === "]" || ch === "|" ||
    ch === LEFT_BRACE
  ) {
    return true;
  }

  // Keywords that end expressions (specifically 'in' for let-bindings)
  if (/[a-zA-Z]/.test(ch)) {
    try {
      const [id] = parseIdentifier(state);
      if (id === "in") return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Parses a complete match expression.
 * `match scrutinee [Type] { | Ctor vars => body ... }`
 */
function parseMatchExpression(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  // 1. Scrutinee
  const [headLit, headTerm, headState] = parseAtomicSystemFTerm(state);

  let scrutineeLit = headLit;
  let scrutinee = headTerm;
  let currentState = headState;

  for (let matchLength = 0;; matchLength = matchLength + 1) {
    currentState = skipWhitespace(currentState);

    // Standard termination checks
    if (isTerminator(currentState)) break;

    const [ch] = peek(currentState);

    // SPECIAL CASE: Stop at '[' because it denotes the return type annotation
    if (ch === "[") break;

    // Parse next term application
    const [atomLit, atomTerm, nextState] = parseAtomicSystemFTerm(currentState);
    scrutineeLit = `${scrutineeLit} ${atomLit}`;
    scrutinee = createSystemFApplication(scrutinee, atomTerm);
    currentState = nextState;
  }

  currentState = skipWhitespace(currentState);

  // 2. Return Type [T]
  const [nextCh, peekState] = peek(currentState);
  if (nextCh !== "[") {
    throw new ParseError(
      withParserState(
        peekState,
        "match requires an explicit return type: match <term> [Type] { ... }",
      ),
    );
  }
  currentState = matchCh(peekState, "[");
  // Ensure we skip whitespace before parsing the type
  currentState = skipWhitespace(currentState);
  const [returnTypeLit, returnType, stateAfterType] = parseSystemFType(
    currentState,
  );

  currentState = skipWhitespace(stateAfterType);
  currentState = matchCh(currentState, "]");

  currentState = skipWhitespace(currentState);
  currentState = matchCh(currentState, LEFT_BRACE);
  currentState = skipWhitespace(currentState);

  const arms: SystemFMatchArm[] = [];

  // 3. Arms
  for (let armLength = 0;; armLength = armLength + 1) {
    currentState = skipWhitespace(currentState);
    const [nextArmCh] = peek(currentState);

    // Check for end of match block
    if (nextArmCh === RIGHT_BRACE) {
      currentState = matchCh(currentState, RIGHT_BRACE);
      break;
    }

    if (nextArmCh !== "|") {
      throw new ParseError(
        withParserState(currentState, "expected '|' to start match arm"),
      );
    }
    currentState = matchCh(currentState, "|");
    currentState = skipWhitespace(currentState);

    // Constructor Name
    const [constructorName, stateAfterCtor] = parseIdentifier(currentState);
    currentState = skipWhitespace(stateAfterCtor);

    // Parameters (identifiers until =>)
    const params: string[] = [];
    for (let paramLength = 0;; paramLength = paramLength + 1) {
      const [isArrow, arrowState] = peekFatArrow(currentState);
      if (isArrow) {
        currentState = matchFatArrow(arrowState);
        break;
      }
      const [param, stateAfterParam] = parseIdentifier(currentState);
      params.push(param);
      currentState = skipWhitespace(stateAfterParam);
    }

    currentState = skipWhitespace(currentState);

    // Body
    const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTerm(currentState);
    currentState = skipWhitespace(stateAfterBody);

    arms.push({ constructorName, params, body: bodyTerm });
    if (bodyLit.length === 0) {
      throw new ParseError(
        withParserState(stateAfterBody, "match arm requires a body"),
      );
    }
  }

  if (arms.length === 0) {
    throw new ParseError(
      withParserState(currentState, "match must declare at least one arm"),
    );
  }

  return [
    `match ${scrutineeLit} [${returnTypeLit}] {...}`,
    { kind: "systemF-match", scrutinee, returnType, arms },
    currentState,
  ];
}

/**
 * Parses a let binding.
 * `let x [: Type] = Val in Body`
 */
function parseLetExpression(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  const [name, stateAfterName] = parseIdentifier(state);
  let currentState = skipWhitespace(stateAfterName);
  let typeAnnotation: BaseType | undefined;
  let typeLit = "";

  // Optional Type Annotation
  const [nextCh] = peek(currentState);
  if (nextCh === COLON) {
    currentState = matchCh(currentState, COLON);
    currentState = skipWhitespace(currentState); // Skip space after colon
    [typeLit, typeAnnotation, currentState] = parseSystemFType(
      currentState,
    );
    currentState = skipWhitespace(currentState);
  }

  currentState = matchCh(currentState, EQUALS);
  currentState = skipWhitespace(currentState);

  // Value Term
  const [valueLit, valueTerm, stateAfterVal] = parseSystemFTerm(currentState);
  currentState = skipWhitespace(stateAfterVal);

  // Expect 'in'
  const [inKw, stateAfterIn] = parseIdentifier(currentState);
  if (inKw !== "in") {
    throw new ParseError(
      withParserState(
        currentState,
        `expected 'in' after let binding value, found '${inKw}'`,
      ),
    );
  }
  currentState = skipWhitespace(stateAfterIn);

  // Body Term
  const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTerm(currentState);

  const letLit = typeLit
    ? `let ${name} : ${typeLit} = ${valueLit} in ${bodyLit}`
    : `let ${name} = ${valueLit} in ${bodyLit}`;

  if (typeAnnotation !== undefined) {
    return [
      letLit,
      createSystemFApplication(
        mkSystemFAbs(name, typeAnnotation, bodyTerm),
        valueTerm,
      ),
      stateAfterBody,
    ];
  }
  return [
    letLit,
    { kind: "systemF-let", name, value: valueTerm, body: bodyTerm },
    stateAfterBody,
  ];
}

const ASCII_PRINTABLE_MIN = 32;
const ASCII_PRINTABLE_MAX = 126;

const isPrintableAscii = (code: number): boolean =>
  code >= ASCII_PRINTABLE_MIN && code <= ASCII_PRINTABLE_MAX;

const consumeRaw = (state: ParserState, expected: string): ParserState => {
  if (state.idx >= state.buf.length) {
    throw new ParseError(
      withParserState(state, `expected '${expected}' but found EOF`),
    );
  }
  const ch = state.buf[state.idx];
  if (ch !== expected) {
    throw new ParseError(
      withParserState(state, `expected '${expected}' but found '${ch}'`),
    );
  }
  return { buf: state.buf, idx: state.idx + 1 };
};

const parseEscape = (
  state: ParserState,
  context: "character" | "string",
): [string, number, ParserState] => {
  if (state.idx >= state.buf.length) {
    throw new ParseError(
      withParserState(state, `unterminated ${context} literal`),
    );
  }
  const esc = state.buf[state.idx];
  let code: number;
  switch (esc) {
    case "n":
      code = 10;
      break;
    case "\\":
      code = 92;
      break;
    case "'":
      code = 39;
      break;
    case '"':
      code = 34;
      break;
    default:
      throw new ParseError(
        withParserState(
          state,
          `unsupported escape sequence '\\${esc}' in ${context} literal`,
        ),
      );
  }
  return [`\\${esc}`, code, { buf: state.buf, idx: state.idx + 1 }];
};

const parseLiteralChar = (
  state: ParserState,
  context: "character" | "string",
): [string, number, ParserState] => {
  if (state.idx >= state.buf.length) {
    throw new ParseError(
      withParserState(state, `unterminated ${context} literal`),
    );
  }
  const ch = state.buf[state.idx];
  if (ch === "\n" || ch === "\r") {
    throw new ParseError(
      withParserState(state, `unterminated ${context} literal`),
    );
  }
  if (ch === "\\") {
    return parseEscape({ buf: state.buf, idx: state.idx + 1 }, context);
  }
  const code = ch.charCodeAt(0);
  if (!isPrintableAscii(code)) {
    throw new ParseError(
      withParserState(state, `non-printable ASCII in ${context} literal`),
    );
  }
  return [ch, code, { buf: state.buf, idx: state.idx + 1 }];
};

const buildNatList = (codes: number[]): SystemFTerm => {
  const natType = makeNatType();
  let term: SystemFTerm = mkSystemFTypeApp(mkSystemFVar("nil"), natType);
  for (let i = codes.length - 1; i >= 0; i--) {
    const consTerm = mkSystemFTypeApp(mkSystemFVar("cons"), natType);
    const head = mkSystemFVar(makeNatLiteralIdentifier(BigInt(codes[i])));
    term = createSystemFApplication(
      createSystemFApplication(consTerm, head),
      term,
    );
  }
  return term;
};

const parseCharLiteralTerm = (
  state: ParserState,
): [string, SystemFTerm, ParserState] => {
  let currentState = consumeRaw(state, "'");
  if (currentState.idx >= currentState.buf.length) {
    throw new ParseError(
      withParserState(currentState, "unterminated character literal"),
    );
  }
  const nextCh = currentState.buf[currentState.idx];
  if (nextCh === "'" || nextCh === "\n" || nextCh === "\r") {
    throw new ParseError(
      withParserState(currentState, "empty character literal"),
    );
  }
  let literalPart: string;
  let code: number;
  if (nextCh === "\\") {
    [literalPart, code, currentState] = parseEscape(
      { buf: currentState.buf, idx: currentState.idx + 1 },
      "character",
    );
  } else {
    [literalPart, code, currentState] = parseLiteralChar(
      currentState,
      "character",
    );
  }
  currentState = consumeRaw(currentState, "'");
  return [
    `'${literalPart}'`,
    mkSystemFVar(makeNatLiteralIdentifier(BigInt(code))),
    currentState,
  ];
};

const parseStringLiteralTerm = (
  state: ParserState,
): [string, SystemFTerm, ParserState] => {
  let currentState = consumeRaw(state, '"');
  const literalParts: string[] = [];
  const codes: number[] = [];

  for (let litLen = 0;; litLen = litLen + 1) {
    if (currentState.idx >= currentState.buf.length) {
      throw new ParseError(
        withParserState(currentState, "unterminated string literal"),
      );
    }
    const ch = currentState.buf[currentState.idx];
    if (ch === '"') {
      currentState = consumeRaw(currentState, '"');
      break;
    }
    if (ch === "\n" || ch === "\r") {
      throw new ParseError(
        withParserState(currentState, "unterminated string literal"),
      );
    }
    let literalPart: string;
    let code: number;
    if (ch === "\\") {
      [literalPart, code, currentState] = parseEscape(
        { buf: currentState.buf, idx: currentState.idx + 1 },
        "string",
      );
    } else {
      [literalPart, code, currentState] = parseLiteralChar(
        currentState,
        "string",
      );
    }
    literalParts.push(literalPart);
    codes.push(code);
  }

  return [`"${literalParts.join("")}"`, buildNatList(codes), currentState];
};

/**
 * Parses an atomic System F term.
 * Atomic terms can be:
 *   - A term abstraction: "\x: T => t"
 *   - A type abstraction: "#X => t"
 *   - A parenthesized term: "(" t ")"
 *   - A match expression: "match <scrutinee> [Type] { | Ctor vars => body ... }"
 *   - A let expression: "let x [: Type] = value in body"
 *   - Literals:
 *     - Numeric literals (e.g. "123")
 *     - Character literals (e.g. "'a'")
 *     - String literals (e.g. "\"ab\"")
 *   - A variable/identifier: e.g. "x"
 *
 * Note: term-level type application `t [T]` is parsed by `parseSystemFTerm` while
 * building an application chain, not as an atom here.
 */
export function parseAtomicSystemFTerm(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  const [ch, currentState] = peek(state);

  // 1. Term Abstraction: \x:T => body
  if (ch === BACKSLASH) {
    const stateAfterLambda = matchCh(currentState, BACKSLASH);
    const stateBeforeVar = skipWhitespace(stateAfterLambda);
    const [varLit, stateAfterVar] = parseIdentifier(stateBeforeVar);

    // Explicitly skip whitespace to ensure we hit ':' even if spacing is loose
    const stateBeforeColon = skipWhitespace(stateAfterVar);
    const stateAfterColon = matchCh(stateBeforeColon, ":");

    const stateBeforeType = skipWhitespace(stateAfterColon);
    const [typeLit, typeAnnotation, stateAfterType] = parseSystemFType(
      stateBeforeType,
    );

    const stateBeforeArrow = skipWhitespace(stateAfterType);
    const stateAfterArrow = matchFatArrow(stateBeforeArrow);

    const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTerm(
      stateAfterArrow,
    );
    return [
      `${BACKSLASH}${varLit}:${typeLit}${FAT_ARROW}${bodyLit}`,
      mkSystemFAbs(varLit, typeAnnotation, bodyTerm),
      stateAfterBody,
    ];
  } // 2. Type Abstraction: #X => body
  else if (ch === HASH) {
    const stateAfterLambdaT = matchCh(state, HASH);
    const stateBeforeVar = skipWhitespace(stateAfterLambdaT);
    const [typeVar, stateAfterVar] = parseIdentifier(stateBeforeVar);

    const stateBeforeArrow = skipWhitespace(stateAfterVar);
    const stateAfterArrow = matchFatArrow(stateBeforeArrow);

    const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTerm(
      stateAfterArrow,
    );
    return [
      `${HASH}${typeVar}${FAT_ARROW}${bodyLit}`,
      mkSystemFTAbs(typeVar, bodyTerm),
      stateAfterBody,
    ];
  } // 3. Parentheses: ( term )
  else if (ch === "(") {
    const stateAfterLP = matchLP(state);
    const [innerLit, innerTerm, stateAfterTerm] = parseSystemFTerm(
      stateAfterLP,
    );
    const stateAfterRP = matchRP(stateAfterTerm);
    return [`(${innerLit})`, innerTerm, stateAfterRP];
  } // 4. Literals
  else if (ch === "'") {
    return parseCharLiteralTerm(currentState);
  } else if (ch === '"') {
    return parseStringLiteralTerm(currentState);
  } else if (isDigit(ch)) {
    const [literal, value, stateAfterLiteral] = parseNumericLiteral(state);
    return [
      literal,
      mkSystemFVar(makeNatLiteralIdentifier(value)),
      stateAfterLiteral,
    ];
  } // 5. Identifiers and Keywords
  else if (ch !== null && /[a-zA-Z]/.test(ch)) {
    const [varLit, stateAfterVar] = parseIdentifier(state);
    // Only `match` and `let` are treated as term-level keywords at this point:
    // - `match` introduces a `systemF-match` form with its own dedicated parser.
    // - `let` introduces a `systemF-let` form with its own dedicated parser.
    // Other reserved words either don't exist in this surface grammar, are handled
    // contextually inside those parsers (e.g. `in` for let-bindings), or are just
    // ordinary identifiers (variables/constructors) in the AST.
    if (varLit === "match") {
      return parseMatchExpression(stateAfterVar);
    }
    if (varLit === "let") {
      return parseLetExpression(stateAfterVar);
    }
    return [varLit, { kind: "systemF-var", name: varLit }, stateAfterVar];
  } else {
    throw new ParseError(
      withParserState(
        currentState,
        `unexpected token '${ch ?? "EOF"}' while parsing atomic term`,
      ),
    );
  }
}

/**
 * Parses a System F term.
 */
export function parseSystemFTerm(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  // 1. Parse the first atom (Head)
  const [headLit, headTerm, headState] = parseAtomicSystemFTerm(state);

  const literals: string[] = [headLit];
  let resultTerm = headTerm;
  let currentState = headState;

  // 2. Loop to parse the tail (Arguments)
  for (let appLength = 0;; appLength = appLength + 1) {
    currentState = skipWhitespace(currentState);

    // Check strict termination conditions
    if (isTerminator(currentState)) {
      break;
    }

    const [ch, peekState] = peek(currentState);

    // Case A: Type Application [T]
    if (ch === "[") {
      const stateAfterLBracket = matchCh(peekState, "[");
      const stateBeforeType = skipWhitespace(stateAfterLBracket);
      const [typeLit, typeArg, stateAfterType] = parseSystemFType(
        stateBeforeType,
      );
      const stateBeforeRBracket = skipWhitespace(stateAfterType);
      const stateAfterRBracket = matchCh(stateBeforeRBracket, "]");

      literals.push(`[${typeLit}]`);
      resultTerm = mkSystemFTypeApp(resultTerm, typeArg);
      currentState = stateAfterRBracket;
      continue;
    }

    // Case B: Term Application (Next Atom)
    try {
      const [atomLit, atomTerm, nextState] = parseAtomicSystemFTerm(
        currentState,
      );
      literals.push(atomLit);
      resultTerm = createSystemFApplication(resultTerm, atomTerm);
      currentState = nextState;
    } catch (e) {
      throw e;
    }
  }

  const cleanLit = literals.reduce((acc, curr) => {
    if (curr.startsWith("[")) return `${acc}${curr}`;
    return `${acc} ${curr}`;
  });

  return [cleanLit, resultTerm, currentState];
}

export function parseSystemF(input: string): [string, SystemFTerm] {
  const [lit, term] = parseWithEOF(input, parseSystemFTerm);
  return [lit, term];
}

export function unparseSystemF(term: SystemFTerm): string {
  switch (term.kind) {
    case "non-terminal": {
      const parts = flattenSystemFApp(term);
      return `${LEFT_PAREN}${
        parts.map(unparseSystemF).join(" ")
      }${RIGHT_PAREN}`;
    }
    case "systemF-var":
      return parseNatLiteralIdentifier(term.name)?.toString() ?? term.name;
    case "systemF-abs":
      return `${BACKSLASH}${term.name}${COLON}${
        unparseSystemFType(term.typeAnnotation)
      }${FAT_ARROW}${unparseSystemF(term.body)}`;
    case "systemF-type-abs":
      return `${HASH}${term.typeVar}${FAT_ARROW}${unparseSystemF(term.body)}`;
    case "systemF-type-app":
      return `${unparseSystemF(term.term)}[${
        unparseSystemFType(term.typeArg)
      }]`;
    case "systemF-match": {
      const arms = term.arms.map((arm) =>
        `| ${arm.constructorName} ${arm.params.join(" ")} -> ${
          unparseSystemF(arm.body)
        }`
      ).join(" ");
      return `match ${unparseSystemF(term.scrutinee)}[${
        unparseSystemFType(term.returnType)
      }] { ${arms} }`;
    }
    case "systemF-let": {
      const ann = term.typeAnnotation !== undefined
        ? ` : ${unparseSystemFType(term.typeAnnotation)}`
        : "";
      return `let ${term.name}${ann} = ${unparseSystemF(term.value)} in ${
        unparseSystemF(term.body)
      }`;
    }
  }
}

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
  remaining,
  skipWhitespace,
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
import { parseChain } from "./chain.ts";
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

function parseSystemFTermUntil(
  state: ParserState,
  stopChars: Set<string>,
  parseAtomic: (state: ParserState) => [string, SystemFTerm, ParserState] =
    parseAtomicSystemFTerm,
): [string, SystemFTerm, ParserState] {
  const literals: string[] = [];
  let resultTerm: SystemFTerm | undefined = undefined;
  let currentState = state;

  for (;;) {
    const [hasRemaining] = remaining(currentState);
    if (!hasRemaining) break;
    const [peeked] = peek(currentState);

    if (peeked === ")") break;
    if (peeked !== null && stopChars.has(peeked)) break;
    if (isAtDefinitionKeywordLine(currentState)) break;

    const [atomLit, atomTerm, newState] = parseAtomic(currentState);
    literals.push(atomLit);

    if (resultTerm === undefined) {
      resultTerm = atomTerm;
    } else {
      resultTerm = createSystemFApplication(resultTerm, atomTerm);
    }

    currentState = skipWhitespace(newState);
  }

  if (resultTerm === undefined) {
    throw new ParseError("expected a term");
  }

  return [literals.join(" "), resultTerm, currentState];
}

function parseMatchExpression(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  const [scrutineeLit, scrutinee, stateAfterScrutinee] = parseSystemFTermUntil(
    state,
    new Set<string>(["[", LEFT_BRACE]),
    parseAtomicSystemFTermNoTypeApp,
  );
  let currentState = skipWhitespace(stateAfterScrutinee);
  const [nextCh, peekState] = peek(currentState);
  if (nextCh !== "[") {
    throw new ParseError(
      "match requires an explicit return type: match <term> [Type] { ... }",
    );
  }
  currentState = matchCh(peekState, "[");
  const [returnTypeLit, returnType, stateAfterType] = parseSystemFType(
    currentState,
  );
  currentState = matchCh(stateAfterType, "]");
  currentState = skipWhitespace(currentState);
  currentState = matchCh(currentState, LEFT_BRACE);
  currentState = skipWhitespace(currentState);

  const arms: SystemFMatchArm[] = [];
  const stopChars = new Set<string>(["|", RIGHT_BRACE]);

  for (;;) {
    const [nextArmCh] = peek(currentState);
    if (nextArmCh === RIGHT_BRACE) {
      currentState = matchCh(currentState, RIGHT_BRACE);
      break;
    }
    if (nextArmCh !== "|") {
      throw new ParseError("expected '|' to start match arm");
    }
    currentState = matchCh(currentState, "|");
    currentState = skipWhitespace(currentState);

    const [constructorName, stateAfterCtor] = parseIdentifier(currentState);
    currentState = skipWhitespace(stateAfterCtor);

    const params: string[] = [];
    for (;;) {
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
    const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTermUntil(
      currentState,
      stopChars,
    );
    currentState = skipWhitespace(stateAfterBody);

    arms.push({ constructorName, params, body: bodyTerm });
    if (bodyLit.length === 0) {
      throw new ParseError("match arm requires a body");
    }
  }

  if (arms.length === 0) {
    throw new ParseError("match must declare at least one arm");
  }

  return [
    `match ${scrutineeLit} [${returnTypeLit}] {...}`,
    { kind: "systemF-match", scrutinee, returnType, arms },
    currentState,
  ];
}

function parseLetExpression(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  const [name, stateAfterName] = parseIdentifier(state);
  let currentState = skipWhitespace(stateAfterName);
  let typeAnnotation: BaseType | undefined;
  let typeLit = "";

  const [nextCh] = peek(currentState);
  if (nextCh === COLON) {
    currentState = matchCh(currentState, COLON);
    [typeLit, typeAnnotation, currentState] = parseSystemFType(
      skipWhitespace(currentState),
    );
    currentState = skipWhitespace(currentState);
  }

  currentState = matchCh(currentState, EQUALS);
  currentState = skipWhitespace(currentState);
  // Parse value term, stopping before the "in" keyword (so "in" is not parsed as a variable).
  const valueParts: [string, SystemFTerm][] = [];
  for (;;) {
    const [ch, peekState] = peek(currentState);
    if (ch !== null && /[a-zA-Z]/.test(ch)) {
      const [id] = parseIdentifier(peekState);
      if (id === "in") break;
    }
    const [lit, term, nextState] = parseAtomicSystemFTerm(currentState);
    valueParts.push([lit, term]);
    currentState = skipWhitespace(nextState);
  }
  if (valueParts.length === 0) {
    throw new ParseError("let binding requires a value");
  }
  let valueLit = valueParts[0][0];
  let valueTerm = valueParts[0][1];
  for (let i = 1; i < valueParts.length; i++) {
    valueLit = `${valueLit} ${valueParts[i][0]}`;
    valueTerm = createSystemFApplication(valueTerm, valueParts[i][1]);
  }
  const [inKw, stateAfterIn] = parseIdentifier(currentState);
  if (inKw !== "in") {
    throw new ParseError(
      `expected 'in' after let binding value, found '${inKw}'`,
    );
  }
  currentState = skipWhitespace(stateAfterIn);
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
    throw new ParseError(`expected '${expected}' but found EOF`);
  }
  const ch = state.buf[state.idx];
  if (ch !== expected) {
    throw new ParseError(`expected '${expected}' but found '${ch}'`);
  }
  return { buf: state.buf, idx: state.idx + 1 };
};

const parseEscape = (
  state: ParserState,
  context: "character" | "string",
): [string, number, ParserState] => {
  if (state.idx >= state.buf.length) {
    throw new ParseError(`unterminated ${context} literal`);
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
        `unsupported escape sequence '\\${esc}' in ${context} literal`,
      );
  }
  return [`\\${esc}`, code, { buf: state.buf, idx: state.idx + 1 }];
};

const parseLiteralChar = (
  state: ParserState,
  context: "character" | "string",
): [string, number, ParserState] => {
  if (state.idx >= state.buf.length) {
    throw new ParseError(`unterminated ${context} literal`);
  }
  const ch = state.buf[state.idx];
  if (ch === "\n" || ch === "\r") {
    throw new ParseError(`unterminated ${context} literal`);
  }
  if (ch === "\\") {
    return parseEscape({ buf: state.buf, idx: state.idx + 1 }, context);
  }
  const code = ch.charCodeAt(0);
  if (!isPrintableAscii(code)) {
    throw new ParseError(`non-printable ASCII in ${context} literal`);
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
    throw new ParseError("unterminated character literal");
  }
  const nextCh = currentState.buf[currentState.idx];
  if (nextCh === "'" || nextCh === "\n" || nextCh === "\r") {
    throw new ParseError("empty character literal");
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

  for (;;) {
    if (currentState.idx >= currentState.buf.length) {
      throw new ParseError("unterminated string literal");
    }
    const ch = currentState.buf[currentState.idx];
    if (ch === '"') {
      currentState = consumeRaw(currentState, '"');
      break;
    }
    if (ch === "\n" || ch === "\r") {
      throw new ParseError("unterminated string literal");
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
 *   - A type application: "t [T]"
 *   - A variable: e.g. "x"
 *
 * Returns a triple: [literal, SystemFTerm, updated state]
 */
function parseAtomicSystemFTermNoTypeApp(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  const [ch, currentState] = peek(state);

  if (ch === BACKSLASH) {
    const stateAfterLambda = matchCh(currentState, BACKSLASH);
    const [varLit, stateAfterVar] = parseIdentifier(stateAfterLambda);
    const stateAfterColon = matchCh(stateAfterVar, ":");
    const [typeLit, typeAnnotation, stateAfterType] = parseSystemFType(
      stateAfterColon,
    );
    const stateAfterArrow = matchFatArrow(stateAfterType);
    const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTerm(
      stateAfterArrow,
    );
    return [
      `${BACKSLASH}${varLit}:${typeLit}${FAT_ARROW}${bodyLit}`,
      mkSystemFAbs(varLit, typeAnnotation, bodyTerm),
      stateAfterBody,
    ];
  } else if (ch === "(") {
    const stateAfterLP = matchLP(state);
    const [innerLit, innerTerm, stateAfterTerm] = parseSystemFTerm(
      stateAfterLP,
    );
    const stateAfterRP = matchRP(stateAfterTerm);
    return [`(${innerLit})`, innerTerm, stateAfterRP];
  } else if (ch === HASH) {
    const stateAfterLambdaT = matchCh(state, HASH);
    const [typeVar, stateAfterVar] = parseIdentifier(stateAfterLambdaT);
    const stateAfterArrow = matchFatArrow(stateAfterVar);
    const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTerm(
      stateAfterArrow,
    );
    return [
      `${HASH}${typeVar}${FAT_ARROW}${bodyLit}`,
      mkSystemFTAbs(typeVar, bodyTerm),
      stateAfterBody,
    ];
  } else if (ch === "'") {
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
  } else if (ch !== null && /[a-zA-Z]/.test(ch)) {
    const [varLit, stateAfterVar] = parseIdentifier(state);
    if (varLit === "match") {
      return parseMatchExpression(stateAfterVar);
    }
    if (varLit === "let") {
      return parseLetExpression(stateAfterVar);
    }
    return [varLit, { kind: "systemF-var", name: varLit }, stateAfterVar];
  } else {
    throw new ParseError(
      `unexpected end-of-input while parsing atomic term: ${ch ?? "EOF"}`,
    );
  }
}

export function parseAtomicSystemFTerm(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  const [ch, currentState] = peek(state);

  if (ch === BACKSLASH) {
    const stateAfterLambda = matchCh(currentState, BACKSLASH);
    const [varLit, stateAfterVar] = parseIdentifier(stateAfterLambda);
    const stateAfterColon = matchCh(stateAfterVar, ":");
    const [typeLit, typeAnnotation, stateAfterType] = parseSystemFType(
      stateAfterColon,
    );
    const stateAfterArrow = matchFatArrow(stateAfterType);
    const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTerm(
      stateAfterArrow,
    );
    return [
      `${BACKSLASH}${varLit}:${typeLit}${FAT_ARROW}${bodyLit}`,
      mkSystemFAbs(varLit, typeAnnotation, bodyTerm),
      stateAfterBody,
    ];
  } else if (ch === "(") {
    const stateAfterLP = matchLP(state);
    const [innerLit, innerTerm, stateAfterTerm] = parseSystemFTerm(
      stateAfterLP,
    );
    const stateAfterRP = matchRP(stateAfterTerm);
    return [`(${innerLit})`, innerTerm, stateAfterRP];
  } else if (ch === HASH) {
    const stateAfterLambdaT = matchCh(state, HASH);
    const [typeVar, stateAfterVar] = parseIdentifier(stateAfterLambdaT);
    const stateAfterArrow = matchFatArrow(stateAfterVar);
    const [bodyLit, bodyTerm, stateAfterBody] = parseSystemFTerm(
      stateAfterArrow,
    );
    return [
      `${HASH}${typeVar}${FAT_ARROW}${bodyLit}`,
      mkSystemFTAbs(typeVar, bodyTerm),
      stateAfterBody,
    ];
  } else if (ch === "'") {
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
  } else if (ch !== null && /[a-zA-Z]/.test(ch)) {
    const [varLit, stateAfterVar] = parseIdentifier(state);
    if (varLit === "match") {
      return parseMatchExpression(stateAfterVar);
    }
    if (varLit === "let") {
      return parseLetExpression(stateAfterVar);
    }
    let literal = varLit;
    let term: SystemFTerm = { kind: "systemF-var", name: varLit };
    let currentState = stateAfterVar;

    for (;;) {
      const [nextCh, stateAfterPeek] = peek(currentState);
      if (nextCh !== "[") break;
      const stateAfterLBracket = matchCh(stateAfterPeek, "[");
      const [typeLit, typeArg, stateAfterType] = parseSystemFType(
        stateAfterLBracket,
      );
      const stateAfterRBracket = matchCh(stateAfterType, "]");
      literal = `${literal}[${typeLit}]`;
      term = mkSystemFTypeApp(term, typeArg);
      currentState = stateAfterRBracket;
    }

    return [literal, term, currentState];
  } else {
    throw new ParseError(
      `unexpected end-of-input while parsing atomic term: ${ch ?? "EOF"}`,
    );
  }
}

/**
 * Parses a complete System F term, handling both term and type application.
 * Returns a triple: [literal, SystemFTerm, updated state]
 */
export function parseSystemFTerm(
  state: ParserState,
): [string, SystemFTerm, ParserState] {
  return parseChain<SystemFTerm>(
    state,
    parseAtomicSystemFTerm,
    createSystemFApplication,
  );
}

/**
 * Parses an input string into a System F term with EOF checking.
 */
export function parseSystemF(input: string): [string, SystemFTerm] {
  const [lit, term] = parseWithEOF(input, parseSystemFTerm);
  return [lit, term];
}

/**
 * Unparses a System F term into ASCII syntax.
 * @param term the System F term
 * @returns a human-readable string representation
 */
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

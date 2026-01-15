/**
 * Parser for Rust struct definitions
 *
 * This module provides parsing functionality for Rust struct definitions,
 * extracting field names and types. It handles Rust-specific syntax including
 * attributes, comments, and generic types.
 *
 * @module
 */

import { ParseError } from "./parseError.ts";
import {
  consume,
  createParserState,
  parseIdentifier,
  type ParserState,
  peek as peekChar,
  skipWhitespace,
} from "./parserState.ts";

export interface StructField {
  name: string;
  type: string;
}

export interface ParsedStruct {
  name: string;
  fields: StructField[];
}

/**
 * Skip a line comment (// ...)
 */
function skipLineComment(state: ParserState): ParserState {
  let current = state;
  while (current.idx < current.buf.length) {
    const ch = current.buf[current.idx];
    if (ch === "\n") {
      return consume(current);
    }
    current = consume(current);
  }
  return current;
}

/**
 * Skip a block comment
 */
function skipBlockComment(state: ParserState): ParserState {
  let current = consume(consume(state)); // Skip /*
  while (current.idx < current.buf.length) {
    const ch = current.buf[current.idx];
    if (
      ch === "*" && current.idx + 1 < current.buf.length &&
      current.buf[current.idx + 1] === "/"
    ) {
      return consume(consume(current)); // Skip */
    }
    current = consume(current);
  }
  throw new ParseError("Unterminated block comment");
}

/**
 * Skip whitespace and comments (both line and block comments)
 */
function skipCommentsAndWhitespace(state: ParserState): ParserState {
  let current = skipWhitespace(state);
  while (current.idx < current.buf.length) {
    const [ch, chState] = peekChar(current);
    if (!ch) break;

    const nextIdx = chState.idx + 1;
    if (nextIdx < current.buf.length) {
      const nextCh = current.buf[nextIdx];
      if (ch === "/" && nextCh === "/") {
        current = skipLineComment(current);
        current = skipWhitespace(current);
      } else if (ch === "/" && nextCh === "*") {
        current = skipBlockComment(current);
        current = skipWhitespace(current);
      } else {
        break;
      }
    } else {
      break;
    }
  }
  return current;
}

/**
 * Parse a Rust attribute (#[...])
 */
function parseAttribute(state: ParserState): ParserState {
  let current = skipCommentsAndWhitespace(state);
  const [ch, chState] = peekChar(current);
  if (ch !== "#") {
    throw new ParseError(`Expected '#' for attribute`);
  }
  current = consume(chState);

  const [bracket, bracketState] = peekChar(current);
  if (bracket !== "[") {
    throw new ParseError(`Expected '[' after '#'`);
  }
  current = consume(bracketState);

  // Parse until matching ]
  let depth = 1;
  while (current.idx < current.buf.length && depth > 0) {
    const ch = current.buf[current.idx];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    current = consume(current);
  }

  if (depth !== 0) {
    throw new ParseError("Unterminated attribute");
  }

  return skipCommentsAndWhitespace(current);
}

/**
 * Skip all attributes at the current position
 */
function skipAttributes(state: ParserState): ParserState {
  let current = state;
  while (current.idx < current.buf.length) {
    const saved = current;
    current = skipCommentsAndWhitespace(current);
    const [ch] = peekChar(current);
    if (ch === "#") {
      current = parseAttribute(current);
    } else {
      return saved;
    }
  }
  return current;
}

/**
 * Parse a Rust type (handles generics, tuples, etc.)
 */
function parseRustType(state: ParserState): [string, ParserState] {
  let current = skipCommentsAndWhitespace(state);
  let typeStr = "";

  // Parse type - can be identifier, generic, tuple, etc.
  // For our purposes, we'll parse until we hit a comma or semicolon
  let depth = 0; // Track angle brackets, parens for generics/tuples
  let inAngle = false;
  let inParen = false;

  while (current.idx < current.buf.length) {
    const ch = current.buf[current.idx];
    if (ch === null) break;

    if (ch === "<") {
      inAngle = true;
      depth++;
      typeStr += ch;
      current = consume(current);
    } else if (ch === ">" && inAngle) {
      depth--;
      if (depth === 0) inAngle = false;
      typeStr += ch;
      current = consume(current);
    } else if (ch === "(") {
      inParen = true;
      depth++;
      typeStr += ch;
      current = consume(current);
    } else if (ch === ")" && inParen) {
      depth--;
      if (depth === 0) inParen = false;
      typeStr += ch;
      current = consume(current);
    } else if ((ch === "," || ch === ";") && depth === 0) {
      break;
    } else {
      typeStr += ch;
      current = consume(current);
    }
  }

  return [typeStr.trim(), current];
}

/**
 * Parse a single struct field
 */
function parseStructField(
  state: ParserState,
): [StructField | null, ParserState] {
  let current = skipCommentsAndWhitespace(state);

  // Check if we're at the end of the struct
  const [ch] = peekChar(current);
  if (ch === "}") {
    return [null, current];
  }

  // Skip field attributes
  current = skipAttributes(current);

  // Parse field name
  const [fieldName, afterName] = parseIdentifier(current);
  current = afterName;

  current = skipCommentsAndWhitespace(current);

  // Expect colon
  const [colon] = peekChar(current);
  if (colon !== ":") {
    throw new ParseError(
      `Expected ':' after field name '${fieldName}'`,
    );
  }
  current = consume(current);

  current = skipCommentsAndWhitespace(current);

  // Parse type
  const [fieldType, afterType] = parseRustType(current);
  current = afterType;

  current = skipCommentsAndWhitespace(current);

  // Optional trailing comma
  const [comma] = peekChar(current);
  if (comma === ",") {
    current = consume(current);
  }

  return [{ name: fieldName, type: fieldType.trim() }, current];
}

/**
 * Parse a Rust struct definition
 *
 * @param source - The Rust source code
 * @param structName - The name of the struct to find (e.g., "SabHeader")
 * @returns The parsed struct with field names and types
 */
export function parseRustStruct(
  source: string,
  structName: string,
): ParsedStruct {
  let state = createParserState(source);

  // Find the struct definition
  const structPattern = new RegExp(
    `(?:^|\\s)struct\\s+${structName}\\s*\\{`,
    "m",
  );
  const match = source.match(structPattern);
  if (!match) {
    throw new ParseError(`Could not find struct '${structName}' in source`);
  }

  // Start parsing from the struct keyword
  state.idx = match.index!;
  state = skipCommentsAndWhitespace(state);

  // Skip "struct" keyword
  const [structKw, afterStruct] = parseIdentifier(state);
  if (structKw !== "struct") {
    throw new ParseError("Internal error: struct keyword not found");
  }
  state = afterStruct;

  state = skipCommentsAndWhitespace(state);

  // Parse struct name
  const [name, afterName] = parseIdentifier(state);
  if (name !== structName) {
    throw new ParseError(`Expected struct name '${structName}', got '${name}'`);
  }
  state = afterName;

  state = skipCommentsAndWhitespace(state);

  // Expect opening brace
  const [brace] = peekChar(state);
  if (brace !== "{") {
    throw new ParseError(`Expected '{' after struct name`);
  }
  state = consume(state);

  // Parse fields
  const fields: StructField[] = [];
  while (state.idx < state.buf.length) {
    state = skipCommentsAndWhitespace(state);

    const [ch] = peekChar(state);
    if (ch === "}") {
      break;
    }

    const [field, afterField] = parseStructField(state);
    if (field === null) {
      break;
    }

    fields.push(field);
    state = afterField;
  }

  return { name, fields };
}

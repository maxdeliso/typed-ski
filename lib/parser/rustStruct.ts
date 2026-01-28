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
  withParserState,
} from "./parserState.ts";
import { HASH } from "./consts.ts";

export interface StructField {
  name: string;
  type: string;
}

export interface ParsedStruct {
  name: string;
  fields: StructField[];
  hasReprC: boolean;
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
  throw new ParseError(withParserState(current, "Unterminated block comment"));
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
  if (ch !== HASH) {
    throw new ParseError(
      withParserState(chState, `Expected '#' for attribute`),
    );
  }
  current = consume(chState);

  const [bracket, bracketState] = peekChar(current);
  if (bracket !== "[") {
    throw new ParseError(
      withParserState(bracketState, `Expected '[' after '#'`),
    );
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
    throw new ParseError(withParserState(current, "Unterminated attribute"));
  }

  return skipCommentsAndWhitespace(current);
}

/**
 * Parse attribute content and check if it's #[repr(C)] or #[repr(C, align(...))]
 * Returns the attribute text and whether it's a repr(C) attribute
 */
function parseAttributeContent(
  state: ParserState,
): [string, boolean, ParserState] {
  let current = state;
  let content = "";
  let hasReprC = false;

  // Skip '#'
  const [hash, hashState] = peekChar(current);
  if (hash !== HASH) {
    throw new ParseError(
      withParserState(hashState, `Expected '#' for attribute`),
    );
  }
  current = consume(hashState);
  content += HASH;

  // Skip '['
  const [bracket, bracketState] = peekChar(current);
  if (bracket !== "[") {
    throw new ParseError(
      withParserState(bracketState, `Expected '[' after '#'`),
    );
  }
  current = consume(bracketState);
  content += "[";

  // Parse until matching ]
  let depth = 1;
  const startIdx = current.idx;
  while (current.idx < current.buf.length && depth > 0) {
    const ch = current.buf[current.idx];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    current = consume(current);
  }

  if (depth !== 0) {
    throw new ParseError(withParserState(current, "Unterminated attribute"));
  }

  // Extract attribute content (without the brackets)
  const attrContent = state.buf.substring(startIdx, current.idx - 1);
  content += attrContent + "]";

  // Check if it's #[repr(C)] or #[repr(C, align(...))]
  // Match: repr(C) or repr(C, align(...))
  const reprCMatch = attrContent.match(
    /repr\s*\(\s*C\s*(?:,\s*align\s*\([^)]+\))?\s*\)/,
  );
  if (reprCMatch) {
    hasReprC = true;
  }

  return [content, hasReprC, skipCommentsAndWhitespace(current)];
}

/**
 * Parse all attributes at the current position, returning whether any is #[repr(C)]
 * Returns: [hasReprC, finalState]
 */
function parseStructAttributes(
  state: ParserState,
): [boolean, ParserState] {
  let current = state;
  let hasReprC = false;

  while (current.idx < current.buf.length) {
    const saved = current;
    current = skipCommentsAndWhitespace(current);
    const [ch] = peekChar(current);
    if (ch === HASH) {
      const [, attrHasReprC, afterAttr] = parseAttributeContent(current);
      if (attrHasReprC) {
        hasReprC = true;
      }
      current = afterAttr;
    } else {
      return [hasReprC, saved];
    }
  }
  return [hasReprC, current];
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
    if (ch === HASH) {
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
      withParserState(
        current,
        `Expected ':' after field name '${fieldName}'`,
      ),
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

  // Parse from the beginning of the file, looking for the struct
  // Parse attributes as we encounter them before the struct keyword
  let hasReprC = false;
  let foundStruct = false;
  let name = "";

  // Parse forward through the file until we find the struct
  while (state.idx < state.buf.length) {
    state = skipCommentsAndWhitespace(state);

    // Check if we're at an attribute (# followed by [)
    const [ch, chState] = peekChar(state);
    if (ch === HASH) {
      // Check if it's actually an attribute (must be followed by '[')
      const nextIdx = chState.idx + 1;
      if (nextIdx < state.buf.length && state.buf[nextIdx] === "[") {
        // Parse attributes and check for repr(C)
        // These attributes might belong to the next struct we encounter
        const [attrHasReprC, afterAttrs] = parseStructAttributes(state);
        hasReprC = attrHasReprC;
        state = afterAttrs;
        state = skipCommentsAndWhitespace(state);
        continue;
      }
    }

    // Skip non-identifier characters
    const [ch2] = peekChar(state);
    if (!ch2 || !/[a-zA-Z_]/.test(ch2)) {
      hasReprC = false;
      state = consume(state);
      continue;
    }

    // Try to parse an identifier
    const saved = state;
    let ident: string;
    let afterIdent: ParserState;
    try {
      [ident, afterIdent] = parseIdentifier(state);
    } catch {
      // Failed to parse identifier, skip this character
      hasReprC = false;
      state = consume(state);
      continue;
    }

    // Not a struct keyword, reset and continue
    if (ident !== "struct") {
      hasReprC = false;
      state = saved;
      state = consume(state);
      continue;
    }

    // Found "struct" keyword, parse struct name
    state = afterIdent;
    state = skipCommentsAndWhitespace(state);
    const [parsedName, afterName] = parseIdentifier(state);

    // Wrong struct name, reset and continue searching
    if (parsedName !== structName) {
      hasReprC = false;
      state = saved;
      state = consume(state);
      continue;
    }

    // Found the struct we're looking for!
    name = parsedName;
    state = afterName;
    foundStruct = true;
    break;
  }

  // If we didn't find the struct, throw an error
  if (!foundStruct) {
    throw new ParseError(
      withParserState(
        state,
        `Could not find struct '${structName}' in source`,
      ),
    );
  }

  state = skipCommentsAndWhitespace(state);

  // Expect opening brace
  const [brace] = peekChar(state);
  if (brace !== "{") {
    throw new ParseError(
      withParserState(state, `Expected '{' after struct name`),
    );
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

  return { name, fields, hasReprC };
}

/**
 * Shared TripLang scanner.
 *
 * `lexTrip` reads TripLang's lexical grammar -- comment, arrow, string,
 * identifier, number, and symbol rules -- for the formatter and linter, which
 * discard whitespace and coarsen keywords/symbols. This module owns the one
 * scanner; consumers adapt the stream to their own token shape.
 *
 * @module
 */

export type ScanKind =
  | "space"
  | "newline"
  | "ident"
  | "number"
  | "string"
  | "char"
  | "lineComment"
  | "blockComment"
  | "symbol"
  | "arrow"
  | "fatArrow";

export interface ScanToken {
  kind: ScanKind;
  text: string;
  start: number;
  end: number;
  line: number;
  column: number;
}

function isAlpha(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/**
 * Scans `source` into a position-tracked token stream that always retains
 * whitespace. `strict` (used by the formatter lexer) throws on unterminated
 * strings, character literals, and block comments; the lenient mode (used by
 * the statistics tokenizer) stops at end of input instead. The caller owns
 * normalization: `lexTrip` scans CRLF-normalized text, while the statistics
 * path scans raw source so token offsets index the original text.
 */
export function scanTrip(source: string, strict: boolean): ScanToken[] {
  const tokens: ScanToken[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  const push = (
    kind: ScanKind,
    text: string,
    start: number,
    startLine: number,
    startColumn: number,
  ): void => {
    tokens.push({
      kind,
      text,
      start,
      end: index,
      line: startLine,
      column: startColumn,
    });
  };

  const advance = (): string => {
    const ch = source[index]!;
    index++;
    if (ch === "\r") {
      if (source[index] === "\n") index++;
      line++;
      column = 1;
    } else if (ch === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
    return ch;
  };

  while (index < source.length) {
    const ch = source[index]!;
    const start = index;
    const startLine = line;
    const startColumn = column;

    // Newlines: collapse CRLF (and a lone CR) into one newline token.
    if (ch === "\n" || ch === "\r") {
      advance();
      push("newline", "\n", start, startLine, startColumn);
      continue;
    }

    // Runs of spaces and tabs.
    if (ch === " " || ch === "\t") {
      while (
        index < source.length &&
        (source[index] === " " || source[index] === "\t")
      ) {
        advance();
      }
      push("space", source.slice(start, index), start, startLine, startColumn);
      continue;
    }

    // Line comment: "--" to end of line.
    if (source.startsWith("--", index)) {
      advance();
      advance();
      while (
        index < source.length &&
        source[index] !== "\n" &&
        source[index] !== "\r"
      ) {
        advance();
      }
      push(
        "lineComment",
        source.slice(start, index),
        start,
        startLine,
        startColumn,
      );
      continue;
    }

    // Nested block comment: "{- ... -}".
    if (source.startsWith("{-", index)) {
      let depth = 0;
      while (index < source.length) {
        if (source.startsWith("{-", index)) {
          depth++;
          advance();
          advance();
          continue;
        }
        if (source.startsWith("-}", index)) {
          depth--;
          advance();
          advance();
          if (depth === 0) break;
          continue;
        }
        advance();
      }
      if (depth !== 0 && strict) {
        throw new Error(
          `unterminated block comment at ${startLine}:${startColumn}`,
        );
      }
      push(
        "blockComment",
        source.slice(start, index),
        start,
        startLine,
        startColumn,
      );
      continue;
    }

    if (source.startsWith("=>", index)) {
      advance();
      advance();
      push("fatArrow", "=>", start, startLine, startColumn);
      continue;
    }

    if (source.startsWith("->", index)) {
      advance();
      advance();
      push("arrow", "->", start, startLine, startColumn);
      continue;
    }

    if (ch === '"' || ch === "'") {
      const label = ch === '"' ? "string" : "character";
      advance(); // opening quote
      for (;;) {
        if (index >= source.length) {
          if (strict) {
            throw new Error(
              `unterminated ${label} literal at ${startLine}:${startColumn}`,
            );
          }
          break;
        }
        const c = advance();
        if (c === "\n" || c === "\r") {
          if (strict) {
            throw new Error(
              `unterminated ${label} literal at ${startLine}:${startColumn}`,
            );
          }
          continue;
        }
        if (c === "\\") {
          if (index >= source.length) {
            if (strict) {
              throw new Error(
                `unterminated escape sequence at ${startLine}:${startColumn}`,
              );
            }
            break;
          }
          advance();
          continue;
        }
        if (c === ch) break;
      }
      push(
        ch === '"' ? "string" : "char",
        source.slice(start, index),
        start,
        startLine,
        startColumn,
      );
      continue;
    }

    if (isAlpha(ch)) {
      advance();
      while (index < source.length && isIdentChar(source[index]!)) advance();
      push("ident", source.slice(start, index), start, startLine, startColumn);
      continue;
    }

    if (isDigit(ch)) {
      advance();
      while (index < source.length && isDigit(source[index]!)) advance();
      push("number", source.slice(start, index), start, startLine, startColumn);
      continue;
    }

    advance();
    push("symbol", ch, start, startLine, startColumn);
  }

  return tokens;
}

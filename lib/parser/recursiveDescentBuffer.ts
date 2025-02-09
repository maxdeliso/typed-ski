import { ParseError } from './parseError.js';

export class RecursiveDescentBuffer {
  buf!: string;
  idx!: number;

  private variablePattern = /[a-zA-Z]/;

  public constructor(buf: string) {
    this.buf = buf;
    this.idx = 0;
  }

  /**
   * Advances the index while there is whitespace.
   */
  private skipWhitespace(): void {
    // Check the buffer directly to avoid recursive calls.
    while (this.idx < this.buf.length && /\s/.test(this.buf[this.idx])) {
      this.idx++;
    }
  }

  /**
   * Returns the next non-whitespace character, or null if at end-of-buffer.
   */
  peek(): string | null {
    this.skipWhitespace();
    return this.buf[this.idx] ?? null;
  }

  /**
   * Consumes one character.
   */
  consume(): void {
    this.idx++;
  }

  matchLP(): void {
    this.matchCh('(');
  }

  matchRP(): void {
    this.matchCh(')');
  }

  /**
   * Matches the given character (after skipping whitespace).
   */
  matchCh(ch: string): void {
    if (this.peek() !== ch) {
      throw new ParseError(`expected ${ch} but found ${this.peek() ?? 'null'}`);
    }
    this.consume();
  }

  /**
   * Returns whether there is any non-whitespace character left.
   */
  remaining(): boolean {
    this.skipWhitespace();
    return this.idx < this.buf.length;
  }

  /**
   * Parses a variable. Expects the next non-whitespace character to match the variable pattern.
   */
  parseVariable(): string {
    const next = this.peek();
    if (next == null) {
      throw new ParseError('failed to parse variable: no next character');
    }
    if (!this.variablePattern.test(next)) {
      throw new ParseError(`failed to parse variable: ${next} did not match`);
    }
    this.consume();
    return next;
  }
}

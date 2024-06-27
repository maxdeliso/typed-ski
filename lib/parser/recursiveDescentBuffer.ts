import { ParseError } from './parseError'

export class RecursiveDescentBuffer {
  buf!: string
  idx!: number

  private variablePattern = /[a-zA-Z]/

  public constructor (buf: string) {
    this.buf = buf
    this.idx = 0
  }

  peek (): string | null {
    return this.buf[this.idx] || null
  }

  consume (): void {
    this.idx++
  }

  consumeN (n: number): void {
    if (n <= 0) throw new ParseError('n must be positive')
    this.idx += n
  }

  matchLP (): void {
    this.matchCh('(')
  }

  matchRP (): void {
    this.matchCh(')')
  }

  matchCh (ch: string): void {
    if (this.peek() !== ch) {
      throw new ParseError(`Expected ${ch} but found ${this.peek() || 'null'}'`)
    }

    this.consume()
  }

  remaining (): boolean {
    return this.buf[this.idx] !== undefined
  }

  parseVariable (): string {
    const next = this.peek()

    if (next == null) {
      throw new ParseError('failed to parse variable: no next character')
    }

    if (!this.variablePattern.test(next)) {
      throw new ParseError(`failed to parse variable: ${next} did not match`)
    }

    this.consume()
    return next
  }

  peelRemaining (): RecursiveDescentBuffer {
    return new RecursiveDescentBuffer(this.buf.slice(this.idx))
  }
}

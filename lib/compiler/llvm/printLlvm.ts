export class LlvmWriter {
  private readonly lines: string[] = [];

  line(text = ""): void {
    this.lines.push(text);
  }

  indented(text: string): void {
    this.line(`  ${text}`);
  }

  blank(): void {
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== "") {
      this.lines.push("");
    }
  }

  toString(): string {
    return this.lines.join("\n");
  }
}

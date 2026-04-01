import type { SKIExpression } from "../../lib/ski/expression.ts";
import { apply } from "../../lib/ski/expression.ts";
import { term } from "../../lib/ski/terminal.ts";
import type { SKITerminalSymbol } from "../../lib/ski/terminal.ts";

/**
 * DAG wire format: terminals S K I B C P Q R , . E | Uxx | @L,R
 * (space-separated, postorder).
 */
export function toDagWire(expr: SKIExpression): string {
  const order: SKIExpression[] = [];
  const visited = new Set<SKIExpression>();

  function postorder(node: SKIExpression): void {
    if (visited.has(node)) return;
    if (node.kind === "non-terminal") {
      postorder(node.lft);
      postorder(node.rgt);
    }
    visited.add(node);
    order.push(node);
  }

  postorder(expr);

  const nodeToIndex = new Map<SKIExpression, number>();
  order.forEach((node, index) => nodeToIndex.set(node, index));

  const tokens: string[] = [];
  for (const node of order) {
    if (node.kind === "terminal") {
      tokens.push(node.sym);
    } else if (node.kind === "u8") {
      tokens.push("U" + node.value.toString(16).padStart(2, "0").toUpperCase());
    } else {
      tokens.push(
        "@" + nodeToIndex.get(node.lft)! + "," + nodeToIndex.get(node.rgt)!,
      );
    }
  }
  return tokens.join(" ");
}

export const DAG_TERMINAL_CHARS = new Set<string>([
  "S",
  "K",
  "I",
  "B",
  "C",
  "P",
  "Q",
  "R",
  ",",
  ".",
  "E",
  "L",
  "D",
  "M",
  "A",
  "O",
]);

export function dagCharToSym(char: string): SKITerminalSymbol {
  const symbol = char as SKITerminalSymbol;
  if (!DAG_TERMINAL_CHARS.has(char)) {
    throw new Error("invalid DAG terminal: " + char);
  }
  return symbol;
}

export function fromDagWire(dagStr: string): SKIExpression {
  const tokens = dagStr.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new Error("empty DAG");

  const nodes: SKIExpression[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.length === 1 && DAG_TERMINAL_CHARS.has(token)) {
      nodes.push(term(dagCharToSym(token)));
    } else if (token.startsWith("#u8(") && token.endsWith(")")) {
      const byte = parseInt(token.slice(4, -1), 10);
      if (Number.isNaN(byte) || byte < 0 || byte > 255) {
        throw new Error("invalid U8: " + token);
      }
      nodes.push({ kind: "u8", value: byte });
    } else if (token.startsWith("U") && token.length === 3) {
      const byte = parseInt(token.slice(1), 16);
      if (Number.isNaN(byte) || byte < 0 || byte > 255) {
        throw new Error("invalid U8: " + token);
      }
      nodes.push({ kind: "u8", value: byte });
    } else if (token.startsWith("@")) {
      const comma = token.indexOf(",", 1);
      if (comma < 0) throw new Error("invalid app: " + token);
      const left = parseInt(token.slice(1, comma), 10);
      const right = parseInt(token.slice(comma + 1), 10);
      if (left >= i || right >= i || left < 0 || right < 0) {
        throw new Error("invalid app indices: " + token);
      }
      nodes.push(apply(nodes[left]!, nodes[right]!));
    } else {
      throw new Error("invalid DAG token: " + token);
    }
  }
  return nodes[nodes.length - 1]!;
}

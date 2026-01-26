/**
 * Predefined lambda calculus terms.
 *
 * This module provides predefined lambda calculus terms and functions
 * that are commonly used in functional programming and lambda calculus.
 *
 * @module
 */
import { parseLambda } from "../parser/untyped.ts";

export const [, predLambda] = parseLambda(
  "\\n=>\\f=>\\x=>n(\\g=>\\h=>h(g f))(\\u=>x)(\\u=>u)",
);

import { assertEquals, assertThrows } from "std/assert";

import { compile } from "../../lib/meta/frontend.ts";
import {
  bracketLambda,
  eraseSystemF,
  UnChurchNumber,
} from "../../lib/index.ts";
import { resolvePoly } from "../../lib/meta/frontend/compilation.ts";
import { arenaEvaluator } from "../../lib/evaluator/skiEvaluator.ts";
import { CompilationError } from "../../lib/meta/frontend/compilation.ts";

const NO_NAT_SOURCE = `module LiteralNoNat

poly main = 3
`;

const WITH_NAT_SOURCE = `module LiteralWithNat

type Nat = ∀X . (X → X) → X → X

poly main = 3
`;

const SHADOW_NAT_SOURCE = `module ShadowNat

type Bool = ∀B . B → B → B
type Nat = Bool

poly main : Bool = 3
`;

const TERM_ALIAS_SOURCE = `module TermNatAlias

type Nat = ∀X . (X → X) → X → X

poly main : Nat = (λNat : Nat . Nat) 3
`;

const SUBSTITUTION_SOURCE = `module LiteralSubstitution

type Nat = ∀X . (X → X) → X → X

poly literal = 3
poly passthrough = literal
poly main = passthrough
`;

function evaluateMain(source: string): bigint {
  const compiled = compile(source);
  const mainPoly = resolvePoly(compiled, "main");
  const ski = bracketLambda(eraseSystemF(mainPoly.term));
  const nf = arenaEvaluator.reduce(ski);
  return UnChurchNumber(nf);
}

Deno.test("numeric literals require Nat type", async (t) => {
  await t.step("errors when Nat type is not available", () => {
    assertThrows(
      () => compile(NO_NAT_SOURCE),
      CompilationError,
      "Nat",
    );
  });

  await t.step(
    "evaluate to Church numerals when Nat is provided (single module only)",
    () => {
      // Note: This tests single-module compilation. If this module exported Nat
      // and was linked with Prelude (which also exports Nat), there would be
      // a conflict. This module only defines Nat internally, so no conflict.
      assertEquals(evaluateMain(WITH_NAT_SOURCE), 3n);
    },
  );

  await t.step(
    "successful compilation does not leak Nat into later modules",
    () => {
      assertEquals(evaluateMain(WITH_NAT_SOURCE), 3n);
      assertThrows(
        () => compile(NO_NAT_SOURCE),
        CompilationError,
        "Nat",
      );
    },
  );

  await t.step("redefining Nat via another type currently fails", () => {
    assertThrows(
      () => compile(SHADOW_NAT_SOURCE),
      CompilationError,
    );
  });

  await t.step("term-level aliases named Nat do not interfere", () => {
    assertEquals(evaluateMain(TERM_ALIAS_SOURCE), 3n);
  });

  await t.step("literals survive multi-step substitution", () => {
    assertEquals(evaluateMain(SUBSTITUTION_SOURCE), 3n);
  });
});

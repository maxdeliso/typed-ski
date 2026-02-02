import { assert, assertEquals } from "std/assert";
import rsexport, { type RandomSeed } from "random-seed";
const { create } = rsexport;

import {
  type ArenaEvaluatorWasm,
  createArenaEvaluator,
} from "../../lib/evaluator/arenaEvaluator.ts";
import { getOrBuildArenaViews } from "../../lib/evaluator/arenaViews.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { unparseSKI } from "../../lib/ski/expression.ts";
import { randExpression } from "../../lib/ski/generator.ts";
import { arenaEvaluator } from "../../lib/evaluator/skiEvaluator.ts";

let arenaEval: ArenaEvaluatorWasm;

async function setupEvaluator() {
  arenaEval = await createArenaEvaluator();
}

// Setup before all tests
await setupEvaluator();

Deno.test("stepOnce", async (t) => {
  const e1 = parseSKI("III");
  const e2 = parseSKI("II");
  const e3 = parseSKI("I");
  const e4 = parseSKI("KIS");
  const e5 = parseSKI("SKKI");
  const e6 = parseSKI("SKKII");
  const e7 = parseSKI("KI(KI)");

  await t.step(`${unparseSKI(e2)} ⇒ ${unparseSKI(e3)}`, () => {
    const r = arenaEval.stepOnce(e2);
    assertEquals(r.altered, true);
    assertEquals(unparseSKI(r.expr), unparseSKI(e3));
  });

  await t.step(`${unparseSKI(e1)} ⇒ ${unparseSKI(e3)}`, () => {
    const r1 = arenaEval.stepOnce(e1);
    const r2 = arenaEval.stepOnce(r1.expr);

    assert(r1.altered && r2.altered);
    assertEquals(unparseSKI(r2.expr), unparseSKI(e3));
  });

  await t.step(`${unparseSKI(e4)} ⇒ ${unparseSKI(e3)}`, () => {
    const r = arenaEval.stepOnce(e4);
    assert(r.altered);
    assertEquals(unparseSKI(r.expr), unparseSKI(e3));
  });

  await t.step(`${unparseSKI(e5)} ⇒ ${unparseSKI(e7)}`, () => {
    const r = arenaEval.stepOnce(e5);
    assert(r.altered);
    assertEquals(unparseSKI(r.expr), unparseSKI(e7));
  });

  await t.step(`${unparseSKI(e6)} ⇒ ${unparseSKI(e3)}`, () => {
    const r1 = arenaEval.stepOnce(e6);
    const r2 = arenaEval.stepOnce(r1.expr);
    const r3 = arenaEval.stepOnce(r2.expr);

    assert(r1.altered && r2.altered && r3.altered);
    assertEquals(unparseSKI(r3.expr), unparseSKI(e3));
  });
});

Deno.test("singleton and fresh arena reduction equivalence", async (t) => {
  const seed = "df394b";
  const normalizeTests = 19;
  const minLength = 5;
  const maxLength = 12;
  const rs: RandomSeed = create(seed);

  await t.step("runs random-expression normalisation checks", () => {
    for (let testIdx = 0; testIdx < normalizeTests; ++testIdx) {
      const len = rs.intBetween(minLength, maxLength);
      const input = randExpression(rs, len);

      const arenaNormal = arenaEval.reduce(input);
      const symNormal = arenaEvaluator.reduce(input);

      assertEquals(
        unparseSKI(arenaNormal),
        unparseSKI(symNormal),
        `Mismatch in test #${testIdx + 1}:\nexpected: ${
          unparseSKI(symNormal)
        }\ngot: ${unparseSKI(arenaNormal)}`,
      );
    }
  });
});

Deno.test("dumpArena", async (t) => {
  await t.step("returns nodes for arena with expressions", () => {
    const evaluator = arenaEval;
    const expr = parseSKI("I");
    evaluator.toArena(expr);
    const { nodes } = evaluator.dumpArena();

    // Arena should contain at least the terminal nodes (S, K, I) and the expression we added
    assert(nodes.length >= 3, "Arena should contain at least terminal nodes");
  });

  await t.step("correctly dumps terminal nodes", () => {
    const evaluator = arenaEval;
    const expr = parseSKI("I");
    const id = evaluator.toArena(expr);
    const { nodes } = evaluator.dumpArena();

    // Find the node with the given id
    const node = nodes.find((n) => n.id === id);
    assert(node !== undefined, `Node with id ${id} should exist`);
    assertEquals(node.kind, "terminal", "Node should be a terminal");
    if (node.kind === "terminal" && node.sym) {
      assertEquals(node.sym, "I", "Terminal symbol should be I");
    }
  });

  await t.step("round-trips B and C terminals", () => {
    const evaluator = arenaEval;
    const exprB = parseSKI("B");
    const exprC = parseSKI("C");
    const idB = evaluator.toArena(exprB);
    const idC = evaluator.toArena(exprC);

    assertEquals(unparseSKI(evaluator.fromArena(idB)), "B");
    assertEquals(unparseSKI(evaluator.fromArena(idC)), "C");
  });

  await t.step("correctly dumps non-terminal nodes", () => {
    const evaluator = arenaEval;
    const expr = parseSKI("II");
    const id = evaluator.toArena(expr);
    const { nodes } = evaluator.dumpArena();

    // Find the node with the given id
    const node = nodes.find((n) => n.id === id);
    assert(node !== undefined, `Node with id ${id} should exist`);
    assertEquals(node.kind, "non-terminal", "Node should be a non-terminal");
    if (node.kind === "non-terminal") {
      // II is (I)(I), so it should have left and right children
      assert(node.left !== undefined, "Non-terminal should have left child");
      assert(node.right !== undefined, "Non-terminal should have right child");
      // Both children should be I terminals (hash consing means they're the same node)
      const leftNode = nodes.find((n) => n.id === node.left);
      const rightNode = nodes.find((n) => n.id === node.right);
      assert(leftNode !== undefined, "Left child should exist");
      assert(rightNode !== undefined, "Right child should exist");
      if (leftNode && leftNode.kind === "terminal" && leftNode.sym) {
        assertEquals(leftNode.sym, "I", "Left child should be I");
      }
      if (rightNode && rightNode.kind === "terminal" && rightNode.sym) {
        assertEquals(rightNode.sym, "I", "Right child should be I");
      }
    }
  });

  await t.step("correctly dumps complex expressions", () => {
    const evaluator = arenaEval;
    const expr = parseSKI("SKKI");
    const id = evaluator.toArena(expr);
    const { nodes } = evaluator.dumpArena();

    // Find the root node
    const rootNode = nodes.find((n) => n.id === id);
    assert(rootNode !== undefined, `Root node with id ${id} should exist`);
    assertEquals(rootNode.kind, "non-terminal", "Root should be non-terminal");

    // Verify we can reconstruct the expression from the dump
    const reconstructed = evaluator.fromArena(id);
    assertEquals(
      unparseSKI(reconstructed),
      unparseSKI(expr),
      "Reconstructed expression should match original",
    );
  });

  await t.step("includes all nodes for multiple expressions", () => {
    const evaluator = arenaEval;
    // Create different expressions to ensure we have multiple nodes
    const expr1 = parseSKI("I");
    const expr2 = parseSKI("II");
    const expr3 = parseSKI("III");
    const id1 = evaluator.toArena(expr1);
    const id2 = evaluator.toArena(expr2);
    const id3 = evaluator.toArena(expr3);
    const { nodes } = evaluator.dumpArena();

    // All three expressions should be in the dump
    const node1 = nodes.find((n) => n.id === id1);
    const node2 = nodes.find((n) => n.id === id2);
    const node3 = nodes.find((n) => n.id === id3);

    assert(node1 !== undefined, "Node 1 (I) should exist");
    assert(node2 !== undefined, "Node 2 (II) should exist");
    assert(node3 !== undefined, "Node 3 (III) should exist");

    if (node1 && node1.kind === "terminal" && node1.sym) {
      assertEquals(node1.sym, "I", "Node 1 should be I");
    }
    assertEquals(node2.kind, "non-terminal", "Node 2 should be non-terminal");
    assertEquals(node3.kind, "non-terminal", "Node 3 should be non-terminal");
  });

  await t.step("uses views for direct memory access", () => {
    const evaluator = arenaEval;
    const expr = parseSKI("III");
    evaluator.toArena(expr);
    const { nodes } = evaluator.dumpArena();

    // Verify dumpArena works (if it uses views, it should be fast and correct)
    assert(nodes.length > 0, "Arena should contain nodes");
    // Verify all nodes have valid structure
    for (const node of nodes) {
      if (node.kind === "terminal") {
        const sym = node.sym;
        assert(
          sym !== undefined &&
            ["S", "K", "I", "B", "C", "readOne", "writeOne", "?"].includes(sym),
          `Terminal symbol should be S, K, I, B, C, readOne, writeOne, or ? (got ${sym})`,
        );
      } else {
        assert(
          typeof node.left === "number",
          "Non-terminal should have numeric left child",
        );
        assert(
          typeof node.right === "number",
          "Non-terminal should have numeric right child",
        );
        assert(node.left >= 0, "Left child ID should be non-negative");
        assert(node.right >= 0, "Right child ID should be non-negative");
      }
    }
  });

  await t.step("skips holes instead of stopping early", () => {
    const evaluator = arenaEval;
    evaluator.reset();
    // Ensure we have multiple allocated nodes.
    evaluator.toArena(parseSKI("III"));

    const baseAddr = evaluator.$.debugGetArenaBaseAddr?.() ?? 0;
    assert(baseAddr !== 0, "Arena should be initialized");

    const views = getOrBuildArenaViews(evaluator.memory, evaluator.$);
    assert(views !== null, "Arena views should be available");

    // Create an artificial hole at id=0.
    views.kind[0] = 0;

    const { nodes } = evaluator.dumpArena();
    // We should still see later nodes; specifically id=1 should still exist.
    assert(nodes.some((n) => n.id === 1), "Dump should continue past holes");
    // And the holed-out node should not be present as a decoded node.
    assert(!nodes.some((n) => n.id === 0), "Holed-out node should be skipped");

    evaluator.reset();
  });
});

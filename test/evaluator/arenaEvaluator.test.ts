import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import {
  ArenaEvaluatorWasm,
  createArenaEvaluator,
  type ArenaWasmExports,
} from "../../lib/evaluator/arenaEvaluator.ts";
import {
  getLeft,
  getOrBuildArenaViews,
  getRight,
} from "../../lib/evaluator/arenaViews.ts";
import { makeControlPtr } from "../../lib/shared/arena.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import {
  apply,
  equivalent,
  type SKIExpression,
  unparseSKI,
} from "../../lib/ski/expression.ts";
import { EqU8 } from "../../lib/ski/terminal.ts";
import { bracketLambda } from "../../lib/conversion/converter.ts";
import { untypedApp, mkVar } from "../../lib/terms/lambda.ts";

const arenaEval = await createArenaEvaluator();

describe("stepOnce", () => {
  const e1 = parseSKI("III");
  const e2 = parseSKI("II");
  const e3 = parseSKI("I");
  const e4 = parseSKI("KIS");
  const e5 = parseSKI("SKKI");
  const e6 = parseSKI("SKKII");
  const e7 = parseSKI("KI(KI)");

  it(`${unparseSKI(e2)} ⇒ ${unparseSKI(e3)}`, () => {
    const r = arenaEval.stepOnce(e2);
    assert.deepStrictEqual(r.altered, true);
    assert.deepStrictEqual(unparseSKI(r.expr), unparseSKI(e3));
  });

  it(`${unparseSKI(e1)} ⇒ ${unparseSKI(e3)}`, () => {
    const r1 = arenaEval.stepOnce(e1);
    const r2 = arenaEval.stepOnce(r1.expr);

    assert.ok(r1.altered && r2.altered);
    assert.deepStrictEqual(unparseSKI(r2.expr), unparseSKI(e3));
  });

  it(`${unparseSKI(e4)} ⇒ ${unparseSKI(e3)}`, () => {
    const r = arenaEval.stepOnce(e4);
    assert.ok(r.altered);
    assert.deepStrictEqual(unparseSKI(r.expr), unparseSKI(e3));
  });

  it(`${unparseSKI(e5)} ⇒ ${unparseSKI(e7)}`, () => {
    const r = arenaEval.stepOnce(e5);
    assert.ok(r.altered);
    assert.deepStrictEqual(unparseSKI(r.expr), unparseSKI(e7));
  });

  it(`${unparseSKI(e6)} ⇒ ${unparseSKI(e3)}`, () => {
    const r1 = arenaEval.stepOnce(e6);
    const r2 = arenaEval.stepOnce(r1.expr);
    const r3 = arenaEval.stepOnce(r2.expr);

    assert.ok(r1.altered && r2.altered && r3.altered);
    assert.deepStrictEqual(unparseSKI(r3.expr), unparseSKI(e3));
  });

  it("repeated stepOnceArena on the same root chases cached links", () => {
    arenaEval.reset();
    const root = arenaEval.toArena(parseSKI("III"));

    const first = arenaEval.stepOnceArena(root);
    const second = arenaEval.stepOnceArena(root);
    const third = arenaEval.stepOnceArena(root);

    assert.deepStrictEqual(unparseSKI(arenaEval.fromArena(first)), "(II)");
    assert.deepStrictEqual(unparseSKI(arenaEval.fromArena(second)), "I");
    assert.deepStrictEqual(unparseSKI(arenaEval.fromArena(third)), "I");
  });
});

describe("eqU8 intrinsic - reduce to True/False", () => {
  it("eqU8 65 65 reduces to True (K)", () => {
    const u8_65 = { kind: "u8" as const, value: 65 };
    const expr = apply(apply(EqU8, u8_65), u8_65);
    const result = arenaEval.reduce(expr, 10000);
    assert.deepStrictEqual(result.kind, "terminal");
    assert.deepStrictEqual(
      (result as { kind: "terminal"; sym: string }).sym,
      "K",
    );
    assert.deepStrictEqual(unparseSKI(result), "K");
  });

  it("eqU8 65 66 reduces to False (K I)", () => {
    const u8_65 = { kind: "u8" as const, value: 65 };
    const u8_66 = { kind: "u8" as const, value: 66 };
    const expr = apply(apply(EqU8, u8_65), u8_66);
    const result = arenaEval.reduce(expr, 10000);
    const falseForm = parseSKI("(K I)");
    assert.ok(
      equivalent(result, falseForm),
      `expected (K I), got ${unparseSKI(result)}`,
    );
  });

  it("bracketLambda(eqU8 __trip_u8_65 __trip_u8_65) reduces to K", () => {
    const term = untypedApp(
      untypedApp(mkVar("eqU8"), mkVar("__trip_u8_65")),
      mkVar("__trip_u8_65"),
    );
    const ski = bracketLambda(term);
    const result = arenaEval.reduce(ski, 10000);
    assert.deepStrictEqual(unparseSKI(result), "K");
  });
});

describe("Intrinsic Cache Safety", () => {
  const K = parseSKI("K");
  const I = parseSKI("I");
  const FalseForm = apply(K, I);

  const testReductions = () => {
    // eqU8 'a' 'a' -> True (K)
    const u8_97 = { kind: "u8" as const, value: 97 };
    const eqAA = apply(apply(EqU8, u8_97), u8_97);
    const resTrue = arenaEval.reduce(eqAA, 100);
    assert.ok(equivalent(resTrue, K), `Expected K, got ${unparseSKI(resTrue)}`);

    // Verify K behavior: K x y -> x
    const x = { kind: "u8" as const, value: 1 };
    const y = { kind: "u8" as const, value: 2 };
    const kTest = apply(apply(resTrue, x), y);
    const kRes = arenaEval.reduce(kTest, 100);
    assert.ok(
      equivalent(kRes, x),
      `K test failed: expected 1, got ${unparseSKI(kRes)}`,
    );

    // eqU8 'a' 'b' -> False (K I)
    const u8_98 = { kind: "u8" as const, value: 98 };
    const eqAB = apply(apply(EqU8, u8_97), u8_98);
    const resFalse = arenaEval.reduce(eqAB, 100);
    assert.ok(
      equivalent(resFalse, FalseForm),
      `Expected (K I), got ${unparseSKI(resFalse)}`,
    );

    // Verify False behavior: (K I) x y -> y
    const falseTest = apply(apply(resFalse, x), y);
    const falseRes = arenaEval.reduce(falseTest, 100);
    assert.ok(
      equivalent(falseRes, y),
      `False test failed: expected 2, got ${unparseSKI(falseRes)}`,
    );
  };

  it("works after first reset", () => {
    arenaEval.reset();
    testReductions();
  });

  it("works after second reset (verifies cache invalidation)", () => {
    arenaEval.reset();
    testReductions();
  });
});

describe("dumpArena", () => {
  it("returns nodes for arena with expressions", () => {
    const evaluator = arenaEval;
    const expr = parseSKI("I");
    evaluator.toArena(expr);
    const { nodes } = evaluator.dumpArena();

    // Arena should contain at least the terminal nodes (S, K, I) and the expression we added
    assert.ok(
      nodes.length >= 3,
      "Arena should contain at least terminal nodes",
    );
  });

  it("correctly dumps terminal nodes", () => {
    const evaluator = arenaEval;
    const expr = parseSKI("I");
    const id = evaluator.toArena(expr);
    const { nodes } = evaluator.dumpArena();

    // Find the node with the given id
    const node = nodes.find((n) => n.id === id);
    assert.ok(node !== undefined, `Node with id ${id} should exist`);
    assert.deepStrictEqual(node.kind, "terminal", "Node should be a terminal");
    if (node.kind === "terminal" && node.sym) {
      assert.deepStrictEqual(node.sym, "I", "Terminal symbol should be I");
    }
  });

  it("round-trips B and C terminals", () => {
    const evaluator = arenaEval;
    const exprB = parseSKI("B");
    const exprC = parseSKI("C");
    const idB = evaluator.toArena(exprB);
    const idC = evaluator.toArena(exprC);

    assert.deepStrictEqual(unparseSKI(evaluator.fromArena(idB)), "B");
    assert.deepStrictEqual(unparseSKI(evaluator.fromArena(idC)), "C");
  });

  it("correctly dumps non-terminal nodes", () => {
    const evaluator = arenaEval;
    const expr = parseSKI("II");
    const id = evaluator.toArena(expr);
    const { nodes } = evaluator.dumpArena();

    // Find the node with the given id
    const node = nodes.find((n) => n.id === id);
    assert.ok(node !== undefined, `Node with id ${id} should exist`);
    assert.deepStrictEqual(
      node.kind,
      "non-terminal",
      "Node should be a non-terminal",
    );
    if (node.kind === "non-terminal") {
      // II is (I)(I), so it should have left and right children
      assert.ok(node.left !== undefined, "Non-terminal should have left child");
      assert.ok(
        node.right !== undefined,
        "Non-terminal should have right child",
      );
      // Both children should be I terminals (hash consing means they're the same node)
      const leftNode = nodes.find((n) => n.id === node.left);
      const rightNode = nodes.find((n) => n.id === node.right);
      assert.ok(leftNode !== undefined, "Left child should exist");
      assert.ok(rightNode !== undefined, "Right child should exist");
      if (leftNode && leftNode.kind === "terminal" && leftNode.sym) {
        assert.deepStrictEqual(leftNode.sym, "I", "Left child should be I");
      }
      if (rightNode && rightNode.kind === "terminal" && rightNode.sym) {
        assert.deepStrictEqual(rightNode.sym, "I", "Right child should be I");
      }
    }
  });

  it("correctly dumps complex expressions", () => {
    const evaluator = arenaEval;
    const expr = parseSKI("SKKI");
    const id = evaluator.toArena(expr);
    const { nodes } = evaluator.dumpArena();

    // Find the root node
    const rootNode = nodes.find((n) => n.id === id);
    assert.ok(rootNode !== undefined, `Root node with id ${id} should exist`);
    assert.deepStrictEqual(
      rootNode.kind,
      "non-terminal",
      "Root should be non-terminal",
    );

    // Verify we can reconstruct the expression from the dump
    const reconstructed = evaluator.fromArena(id);
    assert.deepStrictEqual(
      unparseSKI(reconstructed),
      unparseSKI(expr),
      "Reconstructed expression should match original",
    );
  });

  it("dumpArena includes U8 nodes when using views", () => {
    const evaluator = arenaEval;
    const u8_5 = parseSKI("#u8(5)");
    const u8_6 = parseSKI("#u8(6)");
    const expr = apply(apply(EqU8, u8_5), u8_6);
    evaluator.toArena(expr);
    const { nodes } = evaluator.dumpArena();
    const u8Node = nodes.find(
      (n) => n.kind === "terminal" && /^#u8\(\d+\)$/.test(n.sym ?? ""),
    );
    assert.ok(
      u8Node !== undefined,
      "dumpArena should include U8 terminal node",
    );
  });

  it("includes all nodes for multiple expressions", () => {
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

    assert.ok(node1 !== undefined, "Node 1 (I) should exist");
    assert.ok(node2 !== undefined, "Node 2 (II) should exist");
    assert.ok(node3 !== undefined, "Node 3 (III) should exist");

    if (node1 && node1.kind === "terminal" && node1.sym) {
      assert.deepStrictEqual(node1.sym, "I", "Node 1 should be I");
    }
    assert.deepStrictEqual(
      node2.kind,
      "non-terminal",
      "Node 2 should be non-terminal",
    );
    assert.deepStrictEqual(
      node3.kind,
      "non-terminal",
      "Node 3 should be non-terminal",
    );
  });

  it("uses views for direct memory access", () => {
    const evaluator = arenaEval;
    const expr = parseSKI("III");
    evaluator.toArena(expr);
    const { nodes } = evaluator.dumpArena();

    // Verify dumpArena works (if it uses views, it should be fast and correct)
    assert.ok(nodes.length > 0, "Arena should contain nodes");
    // Verify all nodes have valid structure
    for (const node of nodes) {
      if (node.kind === "terminal") {
        const sym = node.sym;
        assert.ok(
          sym !== undefined &&
            ([
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
              "?",
            ].includes(sym) ||
              /^#u8\(\d+\)$/.test(sym)),
          "Terminal symbol should be S, K, I, B, C, P, Q, R, `,`, `.`, E, L, D, M, A, O, #u8(n), or `?` " +
            `(got ${sym})`,
        );
      } else {
        assert.ok(
          typeof node.left === "number",
          "Non-terminal should have numeric left child",
        );
        assert.ok(
          typeof node.right === "number",
          "Non-terminal should have numeric right child",
        );
        assert.ok(node.left >= 0, "Left child ID should be non-negative");
        assert.ok(node.right >= 0, "Right child ID should be non-negative");
      }
    }
  });

  it("skips holes instead of stopping early", () => {
    const evaluator = arenaEval;
    evaluator.reset();
    // Ensure we have multiple allocated nodes.
    evaluator.toArena(parseSKI("III"));

    const baseAddr = evaluator.$.debugGetArenaBaseAddr?.() ?? 0;
    assert.ok(baseAddr !== 0, "Arena should be initialized");

    const views = getOrBuildArenaViews(evaluator.memory, evaluator.$);
    assert.ok(views !== null, "Arena views should be available");

    // Create an artificial hole at id=0 (SoA: kind at baseAddr + offsetNodeKind + 0).
    const kindByte = views.baseAddr + views.offsetNodeKind + 0;
    new Uint8Array(views.buffer)[kindByte] = 0;

    const { nodes } = evaluator.dumpArena();
    // We should still see later nodes; specifically id=1 should still exist.
    assert.ok(
      nodes.some((n) => n.id === 1),
      "Dump should continue past holes",
    );
    // And the holed-out node should not be present as a decoded node.
    assert.ok(
      !nodes.some((n) => n.id === 0),
      "Holed-out node should be skipped",
    );

    evaluator.reset();
  });
});

describe("ArenaEvaluatorWasm - edge cases and coverage", () => {
  it("stepOnceArena delegates directly to arenaKernelStep", () => {
    const evaluator = ArenaEvaluatorWasm.fromInstance(
      {
        reset: () => {},
        allocTerminal: () => 0,
        allocCons: () => 0,
        allocU8: () => 0,
        arenaKernelStep: (id: number) => id + 1,
        reduce: () => 0,
        kindOf: () => 0,
        symOf: () => 0,
        leftOf: () => 0,
        rightOf: () => 0,
      },
      new WebAssembly.Memory({ initial: 1, shared: true, maximum: 1 }),
    );

    assert.deepStrictEqual(evaluator.stepOnceArena(41), 42);
  });

  it("hostSubmit and hostPullV2 throw if missing from WASM", () => {
    // We need a real instance but with missing optional exports.
    // The createArenaEvaluator() returns a real one.
    const evaluator = ArenaEvaluatorWasm.fromInstance(
      {
        reset: () => {},
        allocTerminal: () => 0,
        allocCons: () => 0,
        allocU8: () => 0,
        arenaKernelStep: () => 0,
        reduce: () => 0,
        kindOf: () => 0,
        symOf: () => 0,
        leftOf: () => 0,
        rightOf: () => 0,
      },
      new WebAssembly.Memory({ initial: 1, shared: true, maximum: 1 }),
    );

    assert.throws(() => evaluator.hostSubmit(0, 0, 0), {
      message: "hostSubmit export missing",
    });
    assert.throws(() => evaluator.hostPullV2(), {
      message: "hostPullV2 export missing",
    });
  });

  it("hostPullV2 delegates to WASM export when present", () => {
    const evaluator = ArenaEvaluatorWasm.fromInstance(
      {
        reset: () => {},
        allocTerminal: () => 0,
        allocCons: () => 0,
        allocU8: () => 0,
        arenaKernelStep: () => 0,
        reduce: () => 0,
        kindOf: () => 0,
        symOf: () => 0,
        leftOf: () => 0,
        rightOf: () => 0,
        hostPullV2: () => 123n,
      },
      new WebAssembly.Memory({ initial: 1, shared: true, maximum: 1 }),
    );

    assert.deepStrictEqual(evaluator.hostPullV2(), 123n);
  });

  it("hostSubmit delegates to WASM export when present", () => {
    let receivedArgs: [number, number, number] | null = null;
    const evaluator = ArenaEvaluatorWasm.fromInstance(
      {
        reset: () => {},
        allocTerminal: () => 0,
        allocCons: () => 0,
        allocU8: () => 0,
        arenaKernelStep: () => 0,
        reduce: () => 0,
        kindOf: () => 0,
        symOf: () => 0,
        leftOf: () => 0,
        rightOf: () => 0,
        hostSubmit: (nodeId, reqId, maxSteps) => {
          receivedArgs = [nodeId, reqId, maxSteps];
          return 7;
        },
      },
      new WebAssembly.Memory({ initial: 1, shared: true, maximum: 1 }),
    );

    assert.deepStrictEqual(evaluator.hostSubmit(-1, -2, -3), 7);
    assert.deepStrictEqual(receivedArgs, [0xffffffff, 0xfffffffe, 0xfffffffd]);
  });

  it("fromArena throws on control pointers", () => {
    const exports = {
      kindOf: () => 0,
      debugGetArenaBaseAddr: () => 0,
      reset: () => {},
      allocTerminal: () => 0,
      allocCons: () => 0,
      allocU8: () => 0,
      arenaKernelStep: () => 0,
      reduce: () => 0,
      symOf: () => 0,
      leftOf: () => 0,
      rightOf: () => 0,
    } as ArenaWasmExports;

    const evaluator = new ArenaEvaluatorWasm(
      exports,
      new WebAssembly.Memory({ initial: 1 }),
    );

    assert.throws(
      () => evaluator.fromArena(makeControlPtr(1)),
      Error,
      "Cannot convert control pointer",
    );
  });

  it("fromArena throws on unknown arena node kinds", () => {
    const exports = {
      kindOf: () => 99,
      debugGetArenaBaseAddr: () => 0,
      reset: () => {},
      allocTerminal: () => 0,
      allocCons: () => 0,
      allocU8: () => 0,
      arenaKernelStep: () => 0,
      reduce: () => 0,
      symOf: () => 0,
      leftOf: () => 0,
      rightOf: () => 0,
    } as ArenaWasmExports;

    const evaluator = new ArenaEvaluatorWasm(
      exports,
      new WebAssembly.Memory({ initial: 1 }),
    );

    assert.throws(
      () => evaluator.fromArena(1),
      Error,
      "Cannot convert arena node 1 with kind 99",
    );
  });

  it("toArena throws on unknown terminal symbols", () => {
    const exports = {
      allocTerminal: () => 0,
      reset: () => {},
      allocCons: () => 0,
      allocU8: () => 0,
      arenaKernelStep: () => 0,
      reduce: () => 0,
      kindOf: () => 0,
      symOf: () => 0,
      leftOf: () => 0,
      rightOf: () => 0,
    } as ArenaWasmExports;

    const evaluator = new ArenaEvaluatorWasm(
      exports,
      new WebAssembly.Memory({ initial: 1 }),
    );
    const fakeExpr = {
      kind: "terminal",
      sym: "UNKNOWN",
    } as unknown as SKIExpression;

    assert.throws(
      () => evaluator.toArena(fakeExpr),
      Error,
      "Unrecognised terminal symbol",
    );
  });

  it("toArena throws on U8 allocation OOM", () => {
    const exports = {
      allocTerminal: () => 0,
      allocCons: () => 0,
      allocU8: () => 0xffffffff,
      reset: () => {},
      arenaKernelStep: () => 0,
      reduce: () => 0,
      kindOf: () => 0,
      symOf: () => 0,
      leftOf: () => 0,
      rightOf: () => 0,
    } as ArenaWasmExports;

    const evaluator = new ArenaEvaluatorWasm(
      exports,
      new WebAssembly.Memory({ initial: 1 }),
    );

    assert.throws(
      () => evaluator.toArena(parseSKI("#u8(7)")),
      Error,
      "Arena Out of Memory during U8 marshaling",
    );
  });

  it("toArena throws on cons allocation OOM", () => {
    const exports = {
      allocTerminal: () => 0,
      allocCons: () => 0xffffffff,
      allocU8: () => 0,
      reset: () => {},
      arenaKernelStep: () => 0,
      reduce: () => 0,
      kindOf: () => 0,
      symOf: () => 0,
      leftOf: () => 0,
      rightOf: () => 0,
    } as ArenaWasmExports;

    const evaluator = new ArenaEvaluatorWasm(
      exports,
      new WebAssembly.Memory({ initial: 1 }),
    );

    assert.throws(
      () => evaluator.toArena(parseSKI("II")),
      Error,
      "Arena Out of Memory during marshaling",
    );
  });

  it("fromInstance throws when required exports are missing", () => {
    const incompleteExports = {
      reset: () => {},
    } as unknown as ArenaWasmExports;

    assert.throws(
      () =>
        ArenaEvaluatorWasm.fromInstance(
          incompleteExports,
          new WebAssembly.Memory({ initial: 1 }),
        ),
      Error,
      "WASM export `allocTerminal` is missing",
    );
  });

  it("fromInstance throws when required export is not a function", () => {
    const invalidExports = {
      reset: 1,
      allocTerminal: () => 0,
      allocCons: () => 0,
      allocU8: () => 0,
      arenaKernelStep: () => 0,
      reduce: () => 0,
      kindOf: () => 0,
      symOf: () => 0,
      leftOf: () => 0,
      rightOf: () => 0,
    } as unknown as ArenaWasmExports;

    assert.throws(
      () =>
        ArenaEvaluatorWasm.fromInstance(
          invalidExports,
          new WebAssembly.Memory({ initial: 1, shared: true, maximum: 1 }),
        ),
      TypeError,
      "WASM export `reset` is missing or not a function",
    );
  });

  it("fromInstance throws when initArena returns zero", () => {
    const invalidExports = {
      reset: () => {},
      allocTerminal: () => 0,
      allocCons: () => 0,
      allocU8: () => 0,
      arenaKernelStep: () => 0,
      reduce: () => 0,
      kindOf: () => 0,
      symOf: () => 0,
      leftOf: () => 0,
      rightOf: () => 0,
      initArena: () => 0,
    } as ArenaWasmExports;

    assert.throws(
      () =>
        ArenaEvaluatorWasm.fromInstance(
          invalidExports,
          new WebAssembly.Memory({ initial: 1, shared: true, maximum: 1 }),
        ),
      Error,
      "initArena failed for capacity",
    );
  });

  it("reset invalidates terminal cache", () => {
    let allocTerminalCalls = 0;
    const exports = {
      reset: () => {},
      allocTerminal: () => allocTerminalCalls++,
      allocCons: () => 0,
      allocU8: () => 0,
      arenaKernelStep: () => 0,
      reduce: () => 0,
      kindOf: () => 0,
      symOf: () => 0,
      leftOf: () => 0,
      rightOf: () => 0,
    } as ArenaWasmExports;
    const evaluator = new ArenaEvaluatorWasm(
      exports,
      new WebAssembly.Memory({ initial: 1 }),
    );

    evaluator.toArena(parseSKI("I"));
    assert.deepStrictEqual(allocTerminalCalls, 16);

    evaluator.reset();
    evaluator.toArena(parseSKI("I"));
    assert.deepStrictEqual(allocTerminalCalls, 32);
  });

  it("structural hash-consing (consCache)", () => {
    arenaEval.reset();
    // Create two distinct JS objects representing the same SKI expression (I I)
    const e1 = parseSKI("II");
    const e2 = parseSKI("II");
    assert.ok(e1 !== e2, "Expressions should be distinct JS objects");

    const id1 = arenaEval.toArena(e1);
    const id2 = arenaEval.toArena(e2);

    assert.deepStrictEqual(
      id1,
      id2,
      "Equivalent subtrees should reuse the same arena node ID",
    );

    // Even more complex structural reuse
    const e3 = parseSKI("(II)(II)");
    const id3 = arenaEval.toArena(e3);

    const views = getOrBuildArenaViews(arenaEval.memory, arenaEval.$);
    assert.ok(views !== null);
    const leftId = getLeft(id3, views);
    const rightId = getRight(id3, views);
    assert.deepStrictEqual(
      leftId,
      id1,
      "Structural reuse should work for internal nodes",
    );
    assert.deepStrictEqual(
      rightId,
      id1,
      "Structural reuse should work for internal nodes",
    );
  });

  it("connectArena throws when export is missing", () => {
    const evaluator = ArenaEvaluatorWasm.fromInstance(
      {
        reset: () => {},
        allocTerminal: () => 0,
        allocCons: () => 0,
        allocU8: () => 0,
        arenaKernelStep: () => 0,
        reduce: () => 0,
        kindOf: () => 0,
        symOf: () => 0,
        leftOf: () => 0,
        rightOf: () => 0,
      },
      new WebAssembly.Memory({ initial: 1, shared: true, maximum: 1 }),
    );

    assert.throws(
      () => evaluator.connectArena(1),
      Error,
      "connectArena export is missing",
    );
  });

  it("connectArena invalidates terminal cache on success", () => {
    let allocTerminalCalls = 0;
    const exports = {
      reset: () => {},
      allocTerminal: () => allocTerminalCalls++,
      allocCons: () => 0,
      allocU8: () => 0,
      arenaKernelStep: () => 0,
      reduce: () => 0,
      kindOf: () => 0,
      symOf: () => 0,
      leftOf: () => 0,
      rightOf: () => 0,
      connectArena: () => 1,
    } as ArenaWasmExports;

    const evaluator = new ArenaEvaluatorWasm(
      exports,
      new WebAssembly.Memory({ initial: 1, shared: true, maximum: 1 }),
    );

    evaluator.toArena(parseSKI("I"));
    assert.deepStrictEqual(allocTerminalCalls, 16);
    assert.deepStrictEqual(evaluator.connectArena(7), 1);
    evaluator.toArena(parseSKI("I"));
    assert.deepStrictEqual(allocTerminalCalls, 32);
  });
});

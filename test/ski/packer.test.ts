import { assert } from "chai";

import { parseSKI } from "../../lib/parser/ski.ts";
import { type SKIExpression, terminals } from "../../lib/ski/expression.ts";
import {
  type BinaryHeap,
  maxHeapIndex,
  packHeap,
  unpackHeap,
} from "../../lib/ski/packer.ts";

Deno.test("packHeap and unpackHeap", async (t) => {
  const eye = parseSKI("I");
  const quattro = parseSKI("SKKI");

  const assertRepack = (expr: SKIExpression): BinaryHeap => {
    const packed = packHeap(expr);
    const unpacked = unpackHeap(packed);
    assert.deepStrictEqual(expr, unpacked);
    return packed;
  };

  await t.step(
    "packs an expression composed of four symbols into three bytes",
    () => {
      const packResult = assertRepack(quattro);
      const unpacked = unpackHeap(packResult);

      assert.deepStrictEqual(terminals(unpacked), 4);
      assert.deepStrictEqual(packResult.length, 3);
    },
  );

  await t.step("packs and unpacks I to a single byte/symbol", () => {
    const singlePackResult = assertRepack(eye);
    const unpackedSingle = unpackHeap(singlePackResult);

    assert.deepStrictEqual(singlePackResult.length, 1);
    assert.deepStrictEqual(terminals(unpackedSingle), 1);
    assert.deepStrictEqual(eye, unpackedSingle);
  });

  await t.step(
    "packs and unpacks a simple small expression symmetrically",
    () => {
      assertRepack(quattro);
    },
  );
});

Deno.test("maxHeapIndex", async (t) => {
  const eye = parseSKI("I");
  const dos = parseSKI("II");
  const tres = parseSKI("III");
  const toTheRight = parseSKI("(I(S(KI)))");
  const zipper = parseSKI("((I(S(KI)))I)");

  await t.step("returns the largest heap index of different shapes", () => {
    assert.deepStrictEqual(maxHeapIndex(eye), 0);
    assert.deepStrictEqual(maxHeapIndex(dos), 2);
    assert.deepStrictEqual(maxHeapIndex(tres), 4);
    assert.deepStrictEqual(maxHeapIndex(toTheRight), 14);
    assert.deepStrictEqual(maxHeapIndex(zipper), 22);
  });
});

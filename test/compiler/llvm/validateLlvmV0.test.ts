import assert from "node:assert/strict";
import { describe, it } from "../../util/test_shim.ts";
import { validateLlvmV0 } from "../../../lib/compiler/llvm/index.ts";
import {
  block,
  bool,
  data0,
  fn,
  litU8,
  local,
  moduleOf,
  nat,
  param,
  prim,
  u8,
  unit,
} from "./helpers.ts";

describe("LLVM-v0 validation", () => {
  it("rejects unsupported construct", () => {
    const module = moduleOf([
      fn(0, "Main.main", [], u8, [
        block(
          "entry",
          [],
          [
            {
              result: param(0, data0),
              resultType: data0,
              effects: "alloc",
              op: {
                kind: "construct",
                target: 99,
                name: "Main.Box",
                args: [litU8(1)],
              },
            },
          ],
          { kind: "return", value: litU8(0) },
        ),
      ]),
      { kind: "constructor", id: 99, name: "Main.Box", tag: 0, arity: 1 },
    ]);

    assert.throws(
      () => validateLlvmV0(module),
      /LLVM-v0 unsupported: construct requires representation lowering/,
    );
  });

  it("rejects unsupported high-level ADT case", () => {
    const module = moduleOf([
      fn(0, "Main.main", [param(0)], u8, [
        block("entry", [param(0)], [], {
          kind: "case",
          scrutinee: local(0),
          alts: [],
        }),
      ]),
    ]);

    assert.throws(
      () => validateLlvmV0(module),
      /LLVM-v0 unsupported: high-level ADT case requires representation lowering/,
    );
  });

  it("reports unsupported case before phi incoming-edge validation", () => {
    const module = moduleOf([
      fn(0, "Main.main", [param(0)], u8, [
        block("entry", [param(0)], [], {
          kind: "case",
          scrutinee: local(0),
          alts: [],
        }),
        block("caseTarget", [param(1)], [], {
          kind: "return",
          value: local(1),
        }),
      ]),
    ]);

    assert.throws(
      () => validateLlvmV0(module),
      /LLVM-v0 unsupported: high-level ADT case requires representation lowering/,
    );
  });

  it("rejects unsupported types", () => {
    const module = moduleOf([
      fn(0, "Main.main", [], nat, [
        block("entry", [], [], {
          kind: "return",
          value: {
            kind: "literal",
            value: { kind: "nat", value: 1n },
            type: nat,
          },
        }),
      ]),
    ]);

    assert.throws(
      () => validateLlvmV0(module),
      /LLVM-v0 unsupported type.*nat/,
    );
  });

  it("rejects first-class Unit locals", () => {
    const module = moduleOf([
      fn(0, "Main.main", [param(0, unit)], unit, [
        block("entry", [param(0, unit)], [], { kind: "return" }),
      ]),
    ]);

    assert.throws(
      () => validateLlvmV0(module),
      /LLVM-v0 unsupported: first-class Unit value/,
    );
  });

  it("rejects divU8 and modU8", () => {
    for (const name of ["Prelude.divU8", "Prelude.modU8"]) {
      const primitive = prim(1, name);
      const module = moduleOf([
        fn(0, "Main.main", [], u8, [
          block(
            "entry",
            [],
            [
              {
                result: param(0),
                resultType: u8,
                effects: "pure",
                op: {
                  kind: "prim",
                  target: primitive.id,
                  name: primitive.name,
                  args: [litU8(4), litU8(2)],
                },
              },
            ],
            { kind: "return", value: local(0) },
          ),
        ]),
        primitive,
      ]);

      assert.throws(
        () => validateLlvmV0(module),
        new RegExp(`LLVM-v0 unsupported: ${name.split(".").at(-1)}`),
      );
    }
  });

  it("checks primitive signatures against the LLVM primitive table", () => {
    const badResult = moduleOf([
      fn(0, "Main.main", [], u8, [
        block(
          "entry",
          [],
          [
            {
              result: param(0),
              resultType: u8,
              effects: "pure",
              op: {
                kind: "prim",
                target: 1,
                name: "Prelude.eqU8",
                args: [litU8(1), litU8(1)],
              },
            },
          ],
          { kind: "return", value: local(0) },
        ),
      ]),
      prim(1, "Prelude.eqU8"),
    ]);
    badResult.metadata.primitives.delete(1);

    assert.throws(
      () => validateLlvmV0(badResult),
      /primitive Prelude\.eqU8 result.*lowers to i8, expected i1/,
    );

    const badArg = moduleOf([
      fn(0, "Main.main", [param(0, bool)], u8, [
        block(
          "entry",
          [param(0, bool)],
          [
            {
              result: param(1),
              resultType: u8,
              effects: "pure",
              op: {
                kind: "prim",
                target: 1,
                name: "Prelude.addU8",
                args: [local(0, bool), litU8(1)],
              },
            },
          ],
          { kind: "return", value: local(1) },
        ),
      ]),
      prim(1, "Prelude.addU8"),
    ]);
    badArg.metadata.primitives.delete(1);

    assert.throws(
      () => validateLlvmV0(badArg),
      /primitive Prelude\.addU8 arg 0.*lowers to i1, expected i8/,
    );
  });

  it("rejects a block param with no incoming edge", () => {
    const module = moduleOf([
      fn(0, "Main.main", [], u8, [
        block("entry", [], [], { kind: "return", value: litU8(0) }),
        block("join0", [param(0)], [], {
          kind: "return",
          value: local(0),
        }),
      ]),
    ]);

    assert.throws(
      () => validateLlvmV0(module),
      /block join0 has params but no incoming edge/,
    );
  });

  it("rejects duplicate predecessor-to-target edges with different args", () => {
    const module = moduleOf([
      fn(0, "Main.main", [param(0, bool)], u8, [
        block("entry", [param(0, bool)], [], {
          kind: "branch",
          condition: local(0, bool),
          thenTarget: "join0",
          thenArgs: [litU8(1)],
          elseTarget: "join0",
          elseArgs: [litU8(2)],
        }),
        block("join0", [param(1)], [], {
          kind: "return",
          value: local(1),
        }),
      ]),
    ]);

    assert.throws(
      () => validateLlvmV0(module),
      /duplicate predecessor-to-target edge entry -> join0 has different args/,
    );
  });

  it("rejects move without result", () => {
    const module = moduleOf([
      fn(0, "Main.main", [], unit, [
        block(
          "entry",
          [],
          [
            {
              resultType: unit,
              effects: "pure",
              op: { kind: "move", value: litU8(0) },
            },
          ],
          { kind: "return" },
        ),
      ]),
    ]);

    assert.throws(
      () => validateLlvmV0(module),
      /LLVM-v0 unsupported: move without result/,
    );
  });

  it("rejects malformed jump and branch args", () => {
    const badJump = moduleOf([
      fn(0, "Main.main", [], u8, [
        block("entry", [], [], {
          kind: "jump",
          target: "join0",
          args: [],
        }),
        block("join0", [param(0)], [], {
          kind: "return",
          value: local(0),
        }),
      ]),
    ]);

    assert.throws(
      () => validateLlvmV0(badJump),
      /passes 0 args to join0, expected 1/,
    );

    const badBranch = moduleOf([
      fn(0, "Main.main", [param(0, bool)], u8, [
        block("entry", [param(0, bool)], [], {
          kind: "branch",
          condition: local(0, bool),
          thenTarget: "join0",
          thenArgs: [local(0, bool)],
          elseTarget: "join0",
          elseArgs: [local(0, bool)],
        }),
        block("join0", [param(1)], [], {
          kind: "return",
          value: local(1),
        }),
      ]),
    ]);

    assert.throws(
      () => validateLlvmV0(badBranch),
      /arg 0 for join0 type mismatch: expected u8, got bool/,
    );
  });

  it("rejects branch conditions that are not Bool", () => {
    const module = moduleOf([
      fn(0, "Main.main", [param(0)], u8, [
        block("entry", [param(0)], [], {
          kind: "branch",
          condition: local(0),
          thenTarget: "then0",
          thenArgs: [],
          elseTarget: "else0",
          elseArgs: [],
        }),
        block("then0", [], [], { kind: "return", value: litU8(1) }),
        block("else0", [], [], { kind: "return", value: litU8(2) }),
      ]),
    ]);

    assert.throws(
      () => validateLlvmV0(module),
      /Branch condition.*must be bool/,
    );
  });

  it("rejects return value type mismatch", () => {
    const module = moduleOf([
      fn(0, "Main.main", [], bool, [
        block("entry", [], [], { kind: "return", value: litU8(1) }),
      ]),
    ]);

    assert.throws(
      () => validateLlvmV0(module),
      /Return.*type mismatch: expected bool, got u8/,
    );
  });

  it("rejects unknown runtime symbols and bad runtime signatures", () => {
    const unknownRuntime = moduleOf([
      fn(0, "Main.main", [], unit, [
        block(
          "entry",
          [],
          [
            {
              resultType: unit,
              effects: "io",
              op: {
                kind: "runtimeCall",
                name: "trip_missing" as any,
                args: [],
              },
            },
          ],
          { kind: "return" },
        ),
      ]),
    ]);

    assert.throws(
      () => validateLlvmV0(unknownRuntime),
      /Unknown Trip runtime symbol trip_missing/,
    );

    const badSignature = moduleOf([
      fn(0, "Main.main", [], unit, [
        block(
          "entry",
          [],
          [
            {
              resultType: unit,
              effects: "io",
              op: { kind: "runtimeCall", name: "trip_write_one", args: [] },
            },
          ],
          { kind: "return" },
        ),
      ]),
    ]);

    assert.throws(
      () => validateLlvmV0(badSignature),
      /runtimeCall trip_write_one.*wrong arity/,
    );
  });
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { describe, it } from "../../util/test_shim.ts";
import { emitLlvmModule } from "../../../lib/compiler/llvm/index.ts";
import {
  block,
  bool,
  fn,
  litU8,
  local,
  moduleOf,
  param,
  prim,
  u8,
  unit,
} from "./helpers.ts";

const llvmAs = process.env["TYPED_SKI_LLVM_AS"];

describe("LLVM emitter - llvm-as smoke", () => {
  it(
    "assembles emitted LLVM IR with the hermetic LLVM tool",
    { skip: llvmAs ? false : "TYPED_SKI_LLVM_AS is not configured" },
    () => {
      const llvmAsPath = llvmAs;
      assert.ok(llvmAsPath);
      assert.ok(existsSync(llvmAsPath), `llvm-as not found at ${llvmAsPath}`);

      const tempDir = mkdtempSync(join(tmpdir(), "typed-ski-llvm-as-"));
      try {
        for (const [name, ll] of emittedModules()) {
          const llPath = join(tempDir, `${name}.ll`);
          const bcPath = join(tempDir, `${name}.bc`);
          writeFileSync(llPath, ll, "utf8");

          const result: SpawnSyncReturns<string> = spawnSync(
            llvmAsPath,
            [llPath, "-o", bcPath],
            { encoding: "utf8" },
          );
          assert.equal(
            result.status,
            0,
            [
              `llvm-as failed for ${name}`,
              `stdout:\n${result.stdout}`,
              `stderr:\n${result.stderr}`,
              `input:\n${ll}`,
            ].join("\n\n"),
          );
          assert.ok(existsSync(bcPath), `llvm-as did not write ${bcPath}`);
        }
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});

function emittedModules(): Array<[string, string]> {
  return [
    [
      "straight-line",
      emitLlvmModule(
        moduleOf([
          fn(0, "Main.addOne", [param(0)], u8, [
            block(
              "entry",
              [param(0)],
              [
                {
                  result: param(1),
                  resultType: u8,
                  effects: "pure",
                  op: {
                    kind: "prim",
                    target: 1,
                    name: "Prelude.addU8",
                    args: [local(0), litU8(1)],
                  },
                },
              ],
              { kind: "return", value: local(1) },
            ),
          ]),
          prim(1, "Prelude.addU8"),
        ]),
      ),
    ],
    [
      "call-later",
      emitLlvmModule(
        moduleOf([
          fn(0, "Main.main", [], u8, [
            block(
              "entry",
              [],
              [
                {
                  result: param(0),
                  resultType: u8,
                  effects: "unknown",
                  op: {
                    kind: "call",
                    target: 1,
                    name: "Main.inc",
                    args: [litU8(41)],
                  },
                },
              ],
              { kind: "return", value: local(0) },
            ),
          ]),
          fn(1, "Main.inc", [param(0)], u8, [
            block(
              "entry",
              [param(0)],
              [
                {
                  result: param(1),
                  resultType: u8,
                  effects: "pure",
                  op: {
                    kind: "prim",
                    target: 2,
                    name: "Prelude.addU8",
                    args: [local(0), litU8(1)],
                  },
                },
              ],
              { kind: "return", value: local(1) },
            ),
          ]),
          prim(2, "Prelude.addU8"),
        ]),
      ),
    ],
    [
      "branch-phi",
      emitLlvmModule(
        moduleOf([
          fn(0, "Main.choose", [param(0, bool)], u8, [
            block("entry", [param(0, bool)], [], {
              kind: "branch",
              condition: local(0, bool),
              thenTarget: "then0",
              thenArgs: [],
              elseTarget: "else0",
              elseArgs: [],
            }),
            block("then0", [], [], {
              kind: "jump",
              target: "join0",
              args: [litU8(1)],
            }),
            block("else0", [], [], {
              kind: "jump",
              target: "join0",
              args: [litU8(0)],
            }),
            block("join0", [param(1)], [], {
              kind: "return",
              value: local(1),
            }),
          ]),
        ]),
      ),
    ],
    [
      "runtime-call",
      emitLlvmModule(
        moduleOf([
          fn(0, "Main.echo", [], unit, [
            block(
              "entry",
              [],
              [
                {
                  result: param(0),
                  resultType: u8,
                  effects: "io",
                  op: { kind: "runtimeCall", name: "trip_read_one", args: [] },
                },
                {
                  resultType: unit,
                  effects: "io",
                  op: {
                    kind: "runtimeCall",
                    name: "trip_write_one",
                    args: [local(0)],
                  },
                },
              ],
              { kind: "return" },
            ),
          ]),
        ]),
      ),
    ],
  ];
}

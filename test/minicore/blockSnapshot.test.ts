import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "../util/test_shim.ts";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";
import assert from "node:assert/strict";
import {
  anfToBlockModule,
  compileMiniCoreModules,
  toAnfProgram,
  unparseBlockModule,
  type BlockModule,
} from "../../lib/minicore/index.ts";

const MODULE_SOURCES = [
  ["Prelude", join(workspaceRoot, "lib", "prelude.trip")],
  ["Bin", join(workspaceRoot, "lib", "bin.trip")],
  ["Nat", join(workspaceRoot, "lib", "nat.trip")],
  ["Avl", join(workspaceRoot, "lib", "avl.trip")],
  ["AvlNatTreeTest", join(workspaceRoot, "test", "inputs", "avl", "AvlNatTreeTest.trip")],
] as const;

async function compileAvlNatTreeProgram() {
  const modules = await Promise.all(
    MODULE_SOURCES.map(async ([name, url]) => ({
      name,
      source: await readFile(url, "utf8"),
    })),
  );
  return compileMiniCoreModules(modules, "AvlNatTreeTest");
}

function requireBlockFunction(block: BlockModule, name: string) {
  const id = block.symbolsByName.get(name);
  assert.ok(id !== undefined, `missing symbol ${name}`);
  const fn = block.symbols.find(
    (symbol) => symbol.kind === "function" && symbol.id === id,
  );
  assert.ok(fn && fn.kind === "function", `${name} is not a block function`);
  return fn;
}

describe("MiniCore Block IR snapshots", () => {
  it("snapshots generated AVL tree Block IR", async () => {
    const program = await compileAvlNatTreeProgram();
    const block = anfToBlockModule(toAnfProgram(program));
    const height = requireBlockFunction(block, "Avl.height");
    const size = requireBlockFunction(block, "Avl.size");

    assert.strictEqual(
      unparseBlockModule({ ...block, symbols: [height, size] }),
      [
        "function Avl.height(%0: Avl.Avl<K, V>) -> nat [exported] {",
        "  entry(%0: Avl.Avl<K, V>):",
        "    case %0 of",
        "      Avl.Avl.Empty -> case0_alt0_Empty()",
        "      Avl.Avl.Node(%1: Avl.Avl<K, V>, %2: K, %3: V, %4: nat, %5: Avl.Avl<K, V>) -> case0_alt1_Node(%1, %2, %3, %4, %5)",
        "",
        "  case0_alt0_Empty:",
        "    return 0",
        "",
        "  case0_alt1_Node(%1: Avl.Avl<K, V>, %2: K, %3: V, %4: nat, %5: Avl.Avl<K, V>):",
        "    return %4",
        "}",
        "",
        "function Avl.size(%0: Avl.Avl<K, V>) -> nat [exported] {",
        "  entry(%0: Avl.Avl<K, V>):",
        "    case %0 of",
        "      Avl.Avl.Empty -> case0_alt0_Empty()",
        "      Avl.Avl.Node(%1: Avl.Avl<K, V>, %2: K, %3: V, %4: nat, %5: Avl.Avl<K, V>) -> case0_alt1_Node(%1, %2, %3, %4, %5)",
        "",
        "  case0_alt0_Empty:",
        "    return 0",
        "",
        "  case0_alt1_Node(%1: Avl.Avl<K, V>, %2: K, %3: V, %4: nat, %5: Avl.Avl<K, V>):",
        "    %6: nat = call Avl.size(%1) : nat !unknown",
        "    %7: nat = call Avl.size(%5) : nat !unknown",
        "    %8: nat = prim Nat.add(%6, %7) : nat !pure",
        "    %9: nat = prim Nat.succ(%8) : nat !pure",
        "    return %9",
        "}",
      ].join("\n"),
    );
  });
});

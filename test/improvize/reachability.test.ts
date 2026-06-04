import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { pruneUnreachableTripCode } from "../../lib/improvize/reachability.ts";
import {
  cleanupTempWorkspace,
  createTempWorkspace,
} from "../util/tripcHarness.ts";

describe("reachability prune linter", () => {
  it("prunes unreachable definitions, imports, and exports transitively", async () => {
    const workspace = await createTempWorkspace("typed-ski-reachability-");
    try {
      const indexTrip = `module Compiler

import ModA a
import ModA b
import ModA c

export main
export ignored

poly main =
  a

poly unreachable =
  b
`;

      const modATrip = `module ModA

export a
export b
export c

poly a =
  #u8(1)

poly b =
  #u8(2)

poly c =
  #u8(3)
`;

      const indexPath = join(workspace, "index.trip");
      const modAPath = join(workspace, "modA.trip");

      await writeFile(indexPath, indexTrip, "utf8");
      await writeFile(modAPath, modATrip, "utf8");

      await pruneUnreachableTripCode(workspace, "Compiler.main", {
        verbose: false,
      });

      const indexResult = await readFile(indexPath, "utf8");
      const modAResult = await readFile(modAPath, "utf8");

      // Verify index.trip pruning
      assert.match(indexResult, /import ModA a/);
      assert.doesNotMatch(indexResult, /import ModA b/);
      assert.doesNotMatch(indexResult, /import ModA c/);
      assert.match(indexResult, /export main/);
      assert.doesNotMatch(indexResult, /export ignored/);
      assert.match(indexResult, /poly main =/);
      assert.doesNotMatch(indexResult, /poly unreachable =/);

      // Verify modA.trip pruning
      assert.match(modAResult, /export a/);
      assert.doesNotMatch(modAResult, /export b/);
      assert.doesNotMatch(modAResult, /export c/);
      assert.match(modAResult, /poly a =/);
      assert.doesNotMatch(modAResult, /poly b =/);
      assert.doesNotMatch(modAResult, /poly c =/);
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });

  it("handles algebraic data types and keeps constructors", async () => {
    const workspace = await createTempWorkspace("typed-ski-reachability-adt-");
    try {
      const indexTrip = `module Compiler

import ModA MyData
import ModA ctor1
import ModA ctor2

export main

poly main =
  ctor1
`;

      const modATrip = `module ModA

export MyData
export ctor1
export ctor2

data MyData =
  | ctor1
  | ctor2
`;

      const indexPath = join(workspace, "index.trip");
      const modAPath = join(workspace, "modA.trip");

      await writeFile(indexPath, indexTrip, "utf8");
      await writeFile(modAPath, modATrip, "utf8");

      await pruneUnreachableTripCode(workspace, "Compiler.main", {
        verbose: false,
      });

      const indexResult = await readFile(indexPath, "utf8");
      const modAResult = await readFile(modAPath, "utf8");

      // ModA has MyData and ctor1, ctor2. Even though only ctor1 is used,
      // the data declaration must be kept as a whole, including both constructors!
      assert.match(modAResult, /data MyData =/);
      assert.match(modAResult, /\| ctor1/);
      assert.match(modAResult, /\| ctor2/);

      // Index.trip keeps ctor1 import. Since ModA as a whole is kept, we also keep imports.
      // Wait, does index.trip kept imports of ctor2/MyData?
      // Only imports referenced by kept definitions are kept.
      // index.trip kept definitions is main, which references ctor1. So import of ctor1 is kept.
      // MyData and ctor2 are NOT referenced by main in index.trip, so their imports are pruned.
      assert.match(indexResult, /import ModA ctor1/);
      assert.doesNotMatch(indexResult, /import ModA ctor2/);
      assert.doesNotMatch(indexResult, /import ModA MyData/);
    } finally {
      await cleanupTempWorkspace(workspace);
    }
  });
});

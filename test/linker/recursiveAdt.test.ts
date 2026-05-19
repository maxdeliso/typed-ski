/**
 * Test cases for linking modules with recursively defined ADTs.
 *
 * These tests validate that the linker correctly handles recursive types
 * without getting stuck in circular dependency resolution loops.
 */

import { describe, it } from "../util/test_shim.ts";

import assert from "node:assert/strict";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getBinObject } from "../../lib/bin.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { getNatObject } from "../../lib/nat.ts";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";

const srcLinkerDir = join(workspaceRoot, "test", "linker");

describe("linking with recursive ADTs", () => {
  function compileTripFile(tripFileName: string) {
    return compileToObjectFile(
      readFileSync(join(srcLinkerDir, tripFileName), "utf8"),
    );
  }

  it("links a module with a recursive ADT", async () => {
    const adtObject = await compileTripFile("recursive_adt.trip");
    const testObject = await compileTripFile("test_recursive.trip");

    const preludeObject = await getPreludeObject();
    const binObject = await getBinObject();
    const natObject = await getNatObject();

    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "Bin", object: binObject },
      { name: "Nat", object: natObject },
      { name: "RecursiveAdt", object: adtObject },
      { name: "TestRecursive", object: testObject },
    ]);

    assert.strictEqual(typeof skiExpression, "string");
    assert.ok(skiExpression.length > 0);
  });

  it("links a self-referential recursive ADT", async () => {
    const snatObject = await compileTripFile("snat_like.trip");
    const testObject = await compileTripFile("test_snat.trip");

    const preludeObject = await getPreludeObject();
    const binObject = await getBinObject();
    const natObject = await getNatObject();

    const skiExpression = linkModules([
      { name: "Prelude", object: preludeObject },
      { name: "Bin", object: binObject },
      { name: "Nat", object: natObject },
      { name: "SNatLike", object: snatObject },
      { name: "TestSNat", object: testObject },
    ]);

    assert.strictEqual(typeof skiExpression, "string");
    assert.ok(skiExpression.length > 0);
  });
});

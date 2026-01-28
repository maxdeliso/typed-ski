/**
 * Test case for linking modules with recursively defined ADTs
 *
 * This test validates that the linker correctly handles recursive types
 * (types that reference themselves) without getting stuck in circular
 * dependency resolution loops.
 */

import { expect } from "chai";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deserializeTripCObject } from "../../lib/compiler/objectFile.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getPreludeObject } from "../../lib/prelude.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Helper to compile a .trip file to .tripc format
 */
async function compileTripFile(
  tripFileName: string,
  outputTripc?: string,
): Promise<ReturnType<typeof deserializeTripCObject>> {
  const out = outputTripc ?? tripFileName.replace(".trip", ".tripc");
  const tripcPath = join(__dirname, out);

  const compileCommand = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "../../bin/tripc.ts",
      tripFileName,
      out,
    ],
    cwd: __dirname,
  });

  const { code, stderr } = await compileCommand.output();
  if (code !== 0) {
    const errorMsg = new TextDecoder().decode(stderr);
    throw new Error(
      `Failed to compile ${tripFileName}: exit code ${code}\n${errorMsg}`,
    );
  }

  const content = await Deno.readTextFile(tripcPath);
  return deserializeTripCObject(content);
}

Deno.test("linking with recursive ADT", async () => {
  // Step 1: Create a module with a recursive ADT (similar to SNat)
  const recursiveAdtSource = `module RecursiveAdt

import Prelude Nat

export Tree
export Leaf
export Node
export makeLeaf
export makeNode
export getValue

data Tree =
  | Leaf Nat
  | Node Tree Tree

poly makeLeaf = \\n : Nat => Leaf n

poly makeNode = \\left : Tree => \\right : Tree => Node left right

poly getValue = \\t : Tree =>
  match t [Nat] {
    | Leaf n => n
    | Node _ _ => 0
  }
`;

  const sourceFile = join(__dirname, "recursive_adt.trip");
  await Deno.writeTextFile(sourceFile, recursiveAdtSource);

  try {
    // Step 2: Compile the recursive ADT module
    const adtObject = await compileTripFile("recursive_adt.trip");

    // Step 3: Create a test module that imports and uses the recursive type
    const testSource = `module TestRecursive

import RecursiveAdt Tree
import RecursiveAdt Leaf
import RecursiveAdt Node
import RecursiveAdt makeLeaf
import RecursiveAdt makeNode
import RecursiveAdt getValue
import Prelude Nat

export main

poly main = getValue (makeNode (makeLeaf 1) (makeLeaf 2))
`;

    const testFile = join(__dirname, "test_recursive.trip");
    await Deno.writeTextFile(testFile, testSource);

    try {
      // Step 4: Compile the test module
      const testObject = await compileTripFile("test_recursive.trip");

      // Step 5: Link both modules together with Prelude
      const preludeObject = await getPreludeObject();

      const skiExpression = linkModules([
        { name: "Prelude", object: preludeObject },
        { name: "RecursiveAdt", object: adtObject },
        { name: "TestRecursive", object: testObject },
      ], false);

      // Step 6: Verify linking succeeded (produces SKI expression)
      expect(skiExpression).to.be.a("string");
      expect(skiExpression.length).to.be.greaterThan(0);

      console.log(
        "✓ Successfully linked modules with recursive ADT",
      );
      console.log(
        `  SKI expression length: ${skiExpression.length} characters`,
      );
    } finally {
      // Cleanup test files
      try {
        await Deno.remove(testFile);
        await Deno.remove(join(__dirname, "test_recursive.tripc"));
      } catch {
        // Ignore cleanup errors
      }
    }
  } finally {
    // Cleanup source files
    try {
      await Deno.remove(sourceFile);
      await Deno.remove(join(__dirname, "recursive_adt.tripc"));
    } catch {
      // Ignore cleanup errors
    }
  }
});

Deno.test("linking with self-referential recursive ADT (SNat-like)", async () => {
  // Step 1: Create a module with a self-referential recursive ADT (like SNat)
  const snatLikeSource = `module SNatLike

import Prelude Nat
import Prelude add
import Prelude succ
import Prelude zero

export SNat
export SZ
export SS
export toSNat
export fromSNat

data SNat =
  | SZ
  | SS SNat

poly toSNat = \\n : Nat => n [SNat] (\\x : SNat => SS x) SZ

poly fromSNat = \\s : SNat => s [Nat] (\\n : Nat => succ n) zero
`;

  const sourceFile = join(__dirname, "snat_like.trip");
  await Deno.writeTextFile(sourceFile, snatLikeSource);

  try {
    // Step 2: Compile the SNat-like module
    const snatObject = await compileTripFile("snat_like.trip");

    // Step 3: Create a test module that imports and uses SNat
    const testSource = `module TestSNat

import SNatLike SNat
import SNatLike SZ
import SNatLike SS
import SNatLike toSNat
import SNatLike fromSNat
import Prelude Nat
import Prelude zero
import Prelude succ

export main

poly main = fromSNat (SS (SS SZ))
`;

    const testFile = join(__dirname, "test_snat.trip");
    await Deno.writeTextFile(testFile, testSource);

    try {
      // Step 4: Compile the test module
      const testObject = await compileTripFile("test_snat.trip");

      // Step 5: Link both modules together with Prelude
      const preludeObject = await getPreludeObject();

      const skiExpression = linkModules([
        { name: "Prelude", object: preludeObject },
        { name: "SNatLike", object: snatObject },
        { name: "TestSNat", object: testObject },
      ], false);

      // Step 6: Verify linking succeeded
      expect(skiExpression).to.be.a("string");
      expect(skiExpression.length).to.be.greaterThan(0);

      console.log(
        "✓ Successfully linked modules with self-referential recursive ADT",
      );
      console.log(
        `  SKI expression length: ${skiExpression.length} characters`,
      );
    } finally {
      // Cleanup test files
      try {
        await Deno.remove(testFile);
        await Deno.remove(join(__dirname, "test_snat.tripc"));
      } catch {
        // Ignore cleanup errors
      }
    }
  } finally {
    // Cleanup source files
    try {
      await Deno.remove(sourceFile);
      await Deno.remove(join(__dirname, "snat_like.tripc"));
    } catch {
      // Ignore cleanup errors
    }
  }
});

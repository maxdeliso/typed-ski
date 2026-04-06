/**
 * Test cases for linking modules with recursively defined ADTs.
 *
 * These tests validate that the linker correctly handles recursive types
 * without getting stuck in circular dependency resolution loops.
 */

import { afterEach, beforeEach, describe, it } from "node:test";

import { expect } from "../util/assertions.ts";
import {
  cleanupTempWorkspace,
  copyFixtures,
  createTempWorkspace,
  runTripcSync,
} from "../util/tripcHarness.ts";
import { deserializeTripCObject } from "../../lib/compiler/objectFile.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { getBinObject } from "../../lib/bin.ts";
import { getPreludeObject } from "../../lib/prelude.ts";
import { getNatObject } from "../../lib/nat.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_FILES = [
  "recursive_adt.trip",
  "test_recursive.trip",
  "snat_like.trip",
  "test_snat.trip",
] as const;

describe("linking with recursive ADTs", { concurrency: false }, () => {
  let workspacePath: string | null = null;

  beforeEach(async () => {
    workspacePath = await createTempWorkspace("typed-ski-recursive-adt-");
    await copyFixtures(__dirname, workspacePath, FIXTURE_FILES);
  });

  afterEach(async () => {
    await cleanupTempWorkspace(workspacePath);
    workspacePath = null;
  });

  async function compileTripFile(
    tripFileName: string,
    outputTripc?: string,
  ): Promise<ReturnType<typeof deserializeTripCObject>> {
    if (workspacePath === null) {
      throw new Error("Expected test workspace to be prepared");
    }

    const out = outputTripc ?? tripFileName.replace(".trip", ".tripc");
    const tripcPath = join(workspacePath, out);
    const { status: code, stderr } = runTripcSync([tripFileName, out], {
      cwd: workspacePath,
    });

    if (code !== 0) {
      throw new Error(
        `Failed to compile ${tripFileName}: exit code ${code}\n${stderr}`,
      );
    }

    const content = await readFile(tripcPath, "utf8");
    return deserializeTripCObject(content);
  }

  it("links a module with a recursive ADT", async () => {
    const adtObject = await compileTripFile("recursive_adt.trip");
    const testObject = await compileTripFile("test_recursive.trip");

    const preludeObject = await getPreludeObject();
    const binObject = await getBinObject();
    const natObject = await getNatObject();

    const skiExpression = linkModules(
      [
        { name: "Prelude", object: preludeObject },
        { name: "Bin", object: binObject },
        { name: "Nat", object: natObject },
        { name: "RecursiveAdt", object: adtObject },
        { name: "TestRecursive", object: testObject },
      ],
      false,
    );

    expect(skiExpression).to.be.a("string");
    expect(skiExpression.length).to.be.greaterThan(0);
  });

  it("links a self-referential recursive ADT", async () => {
    const snatObject = await compileTripFile("snat_like.trip");
    const testObject = await compileTripFile("test_snat.trip");

    const preludeObject = await getPreludeObject();
    const binObject = await getBinObject();
    const natObject = await getNatObject();

    const skiExpression = linkModules(
      [
        { name: "Prelude", object: preludeObject },
        { name: "Bin", object: binObject },
        { name: "Nat", object: natObject },
        { name: "SNatLike", object: snatObject },
        { name: "TestSNat", object: testObject },
      ],
      false,
    );

    expect(skiExpression).to.be.a("string");
    expect(skiExpression.length).to.be.greaterThan(0);
  });
});

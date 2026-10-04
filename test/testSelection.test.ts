import assert from "node:assert/strict";
import { describe, it } from "./util/test_shim.ts";
import { selectTestFiles } from "../scripts/testSelection.ts";

const files = ["test/compiler/foo.test.js", "test/compiler/bar.test.js"];

describe("compiled test selection", () => {
  it("accepts documented source paths, compiled paths, and Windows separators", () => {
    for (const filter of [
      "test/compiler/foo.test.ts",
      "test/compiler/foo.test.js",
      "test\\compiler\\foo.test.ts",
      "foo.test",
    ]) {
      assert.deepEqual(selectTestFiles(files, [filter]), [files[0]]);
    }
    assert.deepEqual(
      selectTestFiles(files, ["foo.test.ts", "bar.test.ts"]),
      files,
    );
    assert.deepEqual(selectTestFiles(files, []), files);
  });

  it("fails unmatched filters and missing test collections before sharding", () => {
    assert.throws(
      () => selectTestFiles(files, ["missing.test.ts"]),
      /No tests matched filters: missing\.test\.ts/,
    );
    assert.throws(() => selectTestFiles([], []), /No test files found/);
  });
});

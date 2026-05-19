/**
 * Integration tests for the internal TripLang linker.
 */

import { describe, it } from "../util/test_shim.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileToObjectFile } from "../../lib/compiler/singleFileCompiler.ts";
import { linkModules } from "../../lib/linker/moduleLinker.ts";
import { parseSKI } from "../../lib/parser/ski.ts";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";

const srcLinkerDir = join(workspaceRoot, "test", "linker");

function compileFixture(fileName: string) {
  return compileToObjectFile(
    readFileSync(join(srcLinkerDir, fileName), "utf8"),
  );
}

describe("TripLang Linker Integration", () => {
  it("compiles and links a simple expression", () => {
    const object = compileFixture("int_simple.trip");
    const linked = linkModules([{ name: object.module, object }]);
    assert.strictEqual(linked, "I");
  });

  it("compiles and links a complex expression", () => {
    const object = compileFixture("int_complex.trip");
    const linked = linkModules([{ name: object.module, object }]);
    assert.ok(linked.includes("K"));
    assert.doesNotThrow(() => parseSKI(linked));
  });

  it("compiles and links multiple modules", () => {
    const a = compileFixture("int_mod_a.trip");
    const b = compileFixture("int_mod_b.trip");
    const linked = linkModules([
      { name: a.module, object: a },
      { name: b.module, object: b },
    ]);
    assert.strictEqual(typeof linked, "string");
    assert.ok(linked.length > 0);
  });

  it("reports linking errors", () => {
    const object = compileFixture("int_noMain.trip");
    assert.throws(
      () => linkModules([{ name: object.module, object }]),
      /No 'main' function found|Symbol.*is not defined/,
    );
  });

  it("handles large expressions", () => {
    const object = compileFixture("int_large.trip");
    const linked = linkModules([{ name: object.module, object }]);
    assert.strictEqual(typeof linked, "string");
    assert.ok(linked.length > 0);
  });

  it("handles executable wrapper expressions", () => {
    const object = compileFixture("int_exec_wrapper.trip");
    const linked = linkModules([{ name: object.module, object }]);
    assert.strictEqual(typeof linked, "string");
    assert.ok(linked.length > 0);
  });
});

import { expect } from "chai";
import {
  loadTripModuleObject,
  loadTripSourceFile,
  loadTripSourceFileSync,
} from "../lib/tripSourceLoader.ts";
import { join, toFileUrl } from "std/path";

Deno.test("tripSourceLoader - coverage", async (t) => {
  const tempDir = await Deno.makeTempDir();
  const testFile = join(tempDir, "test.trip");
  const testContent = `module Test\npoly main = I`;
  await Deno.writeTextFile(testFile, testContent);
  const testFileUrl = toFileUrl(testFile);

  await t.step("loadTripSourceFile handles URL and caching", async () => {
    // URL support
    const content = await loadTripSourceFile(testFileUrl);
    expect(content).to.equal(testContent);

    // Caching support (second call should hit cache)
    const contentCached = await loadTripSourceFile(testFile);
    expect(contentCached).to.equal(testContent);
  });

  await t.step("loadTripSourceFileSync handles URL and caching", () => {
    // URL support
    const content = loadTripSourceFileSync(testFileUrl);
    expect(content).to.equal(testContent);

    // Caching support
    const contentCached = loadTripSourceFileSync(testFile);
    expect(contentCached).to.equal(testContent);
  });

  await t.step("loadTripModuleObject handles URL and caching", async () => {
    // URL support
    const obj = await loadTripModuleObject(testFileUrl);
    expect(obj).to.have.property("definitions");
    expect(obj).to.have.property("dataDefinitions");

    // Caching support
    const objCached = await loadTripModuleObject(testFile);
    expect(objCached).to.equal(obj);
  });

  await t.step(
    "loadTripModuleObject resolves sibling imports and lower-leading filename fallback",
    async () => {
      const importMain = join(tempDir, "main.trip");
      const importFoo = join(tempDir, "foo.trip");
      await Deno.writeTextFile(
        importMain,
        `module Main
import Foo id
export main
poly main = id`,
      );
      await Deno.writeTextFile(
        importFoo,
        `module Foo
export id
poly id = #a => \\x:a => x`,
      );

      const obj = await loadTripModuleObject(importMain);
      expect(obj.module).to.equal("Main");
      expect(obj.imports).to.deep.equal([{ name: "id", from: "Foo" }]);
    },
  );

  await t.step(
    "loadTripModuleObject tolerates missing imported source files",
    async () => {
      const missingImportMain = join(tempDir, "missing_import.trip");
      await Deno.writeTextFile(
        missingImportMain,
        `module MissingImport
import Ghost thing
export main
poly main = thing`,
      );

      const obj = await loadTripModuleObject(missingImportMain);
      expect(obj.module).to.equal("MissingImport");
      expect(obj.imports).to.deep.equal([{ name: "thing", from: "Ghost" }]);
    },
  );

  await t.step(
    "loadTripModuleObject avoids recursion on cyclic imports",
    async () => {
      const aFile = join(tempDir, "A.trip");
      const bFile = join(tempDir, "B.trip");
      await Deno.writeTextFile(
        aFile,
        `module A
import B b
export a
poly a = b`,
      );
      await Deno.writeTextFile(
        bFile,
        `module B
import A a
export b
poly b = a`,
      );

      const aObj = await loadTripModuleObject(aFile);
      const bObj = await loadTripModuleObject(bFile);
      expect(aObj.module).to.equal("A");
      expect(bObj.module).to.equal("B");
    },
  );

  // Cleanup
  await Deno.remove(tempDir, { recursive: true });
});

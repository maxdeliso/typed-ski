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

  // Cleanup
  await Deno.remove(tempDir, { recursive: true });
});

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  loadTripModuleObject,
  loadTripSourceFile,
  loadTripSourceFileSync,
  resetSourceCache,
} from "../lib/tripSourceLoader.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("tripSourceLoader", async (t) => {
  await t.test("loadTripSourceFile with string path", async () => {
    const path = join(__dirname, "linker", "A.trip");
    const source = await loadTripSourceFile(path);
    assert.ok(source.includes("module A"));
  });

  await t.test("loadTripSourceFile with URL", async () => {
    const path = join(__dirname, "linker", "A.trip");
    const url = new URL(
      `file://${path.startsWith("/") ? "" : "/"}${path.replace(/\\/g, "/")}`,
    );
    const source = await loadTripSourceFile(url);
    assert.ok(source.includes("module A"));
  });

  await t.test("loadTripSourceFile from cache", async () => {
    const path = join(__dirname, "linker", "A.trip");
    resetSourceCache();
    const source1 = await loadTripSourceFile(path);
    const source2 = await loadTripSourceFile(path);
    assert.strictEqual(source1, source2);
  });

  await t.test(
    "loadTripSourceFileSync respects cache and reads from disk",
    () => {
      const path = join(__dirname, "linker", "A.trip");
      resetSourceCache();
      const source1 = loadTripSourceFileSync(path);
      const source2 = loadTripSourceFileSync(path);
      assert.strictEqual(source1, source2);
      assert.ok(source1.includes("module A"));
    },
  );

  await t.test("loadTripModuleObject compiles source to object", async () => {
    const path = join(__dirname, "linker", "A.trip");
    const obj = await loadTripModuleObject(path);
    assert.strictEqual(obj.module, "A");
    assert.ok(obj.exports.includes("addA"));
  });

  await t.test("resolveImportedModuleSourcePath coverage", async () => {
    const path = join(__dirname, "linker", "A.trip");
    const url = new URL(
      `file://${path.startsWith("/") ? "" : "/"}${path.replace(/\\/g, "/")}`,
    );
    const obj = await loadTripModuleObject(url);
    assert.strictEqual(obj.module, "A");
  });
});

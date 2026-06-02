import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "./util/test_shim.ts";
import { workspaceRoot } from "../lib/shared/workspaceRoot.ts";
import {
  loadTripModuleObject,
  loadTripSourceFile,
  loadTripSourceFileSync,
  resetSourceCache,
} from "../lib/tripSourceLoader.ts";

const srcRoot = workspaceRoot;

describe("tripSourceLoader", () => {
  it("loadTripSourceFile with string path", async () => {
    const path = join(srcRoot, "test", "inputs", "tripSourceLoaderModule.trip");
    const source = await loadTripSourceFile(path);
    assert.ok(source.includes("module A"));
  });

  it("loadTripSourceFile with URL", async () => {
    const path = join(srcRoot, "test", "inputs", "tripSourceLoaderModule.trip");
    const url = new URL(
      `file://${path.startsWith("/") ? "" : "/"}${path.replace(/\\/g, "/")}`,
    );
    const source = await loadTripSourceFile(url);
    assert.ok(source.includes("module A"));
  });

  it("loadTripSourceFile from cache", async () => {
    const path = join(srcRoot, "test", "inputs", "tripSourceLoaderModule.trip");
    resetSourceCache();
    const source1 = await loadTripSourceFile(path);
    const source2 = await loadTripSourceFile(path);
    assert.strictEqual(source1, source2);
  });

  it("loadTripSourceFileSync respects cache and reads from disk", () => {
    const path = join(srcRoot, "test", "inputs", "tripSourceLoaderModule.trip");
    resetSourceCache();
    const source1 = loadTripSourceFileSync(path);
    const source2 = loadTripSourceFileSync(path);
    assert.strictEqual(source1, source2);
    assert.ok(source1.includes("module A"));
  });

  it("loadTripModuleObject compiles source to object", async () => {
    const path = join(srcRoot, "test", "inputs", "tripSourceLoaderModule.trip");
    const obj = await loadTripModuleObject(path);
    assert.strictEqual(obj.module, "A");
    assert.ok(obj.exports.includes("addA"));
  });

  it("resolveImportedModuleSourcePath coverage", async () => {
    const path = join(srcRoot, "test", "inputs", "tripSourceLoaderModule.trip");
    const url = new URL(
      `file://${path.startsWith("/") ? "" : "/"}${path.replace(/\\/g, "/")}`,
    );
    const obj = await loadTripModuleObject(url);
    assert.strictEqual(obj.module, "A");
  });
});

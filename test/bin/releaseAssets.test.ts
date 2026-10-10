import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "../util/test_shim.ts";
import { workspaceRoot } from "../../lib/shared/workspaceRoot.ts";

const { releaseAssets, ensureReleaseAssets, platforms } = await import(
  pathToFileURL(join(workspaceRoot, "scripts/release_assets.mjs")).href
);

describe("Release binary assets", () => {
  it("recovers an empty interrupted upload without deleting completed assets", async () => {
    const calls: string[] = [];
    const file = { name: "binary", size: 3, sha256: "expected" };
    await ensureReleaseAssets(
      [file],
      [{ name: "binary", state: "starter", size: 0 }],
      async () => {
        calls.push("upload");
      },
      async () => {
        throw new Error("must not download starter");
      },
      async () => {
        calls.push("remove");
      },
    );
    assert.deepEqual(calls, ["remove", "upload"]);
  });
  it("requires all platforms and produces SHA-256 and SHA-512 manifests", () => {
    const root = mkdtempSync(join(tmpdir(), "release-assets-"));
    try {
      assert.throws(
        () => releaseAssets(root, "0.41.123"),
        /each release platform/,
      );
      for (const platform of platforms) {
        writeFileSync(
          join(root, `typed-ski-0.41.123-${platform}.tar.gz`),
          "abc",
        );
      }
      assert.equal(releaseAssets(root, "0.41.123").length, 5);
      for (const algorithm of ["sha256", "sha512"]) {
        const hash = createHash(algorithm).update("abc").digest("hex");
        const manifest = readFileSync(
          join(root, `${algorithm.toUpperCase()}SUMS`),
          "utf8",
        );
        assert.equal(manifest.split("\n").filter(Boolean).length, 3);
        assert.ok(manifest.startsWith(`${hash}  typed-ski-0.41.123-`));
      }
      const before = readFileSync(join(root, "SHA512SUMS"));
      releaseAssets(root, "0.41.123");
      assert.deepEqual(readFileSync(join(root, "SHA512SUMS")), before);
      writeFileSync(join(root, "unexpected.tar.gz"), "abc");
      assert.throws(
        () => releaseAssets(root, "0.41.123"),
        /each release platform/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uploads only missing assets and refuses to overwrite different bytes", async () => {
    const sha256 = createHash("sha256").update("abc").digest("hex");
    const files = [
      { name: "binary", size: 3, sha256 },
      { name: "sums", size: 3, sha256 },
    ];
    const existing = [
      {
        name: "binary",
        size: 3,
        state: "uploaded",
        digest: `sha256:${sha256}`,
      },
    ];
    const uploaded: string[] = [];
    const upload = async (file: { name: string }) => {
      uploaded.push(file.name);
    };
    const download = async () => Buffer.from("abc");
    await ensureReleaseAssets(files, existing, upload, download);
    assert.deepEqual(uploaded, ["sums"]);
    await assert.rejects(
      ensureReleaseAssets(
        files,
        [{ ...existing[0], digest: "sha256:wrong" }],
        upload,
        download,
      ),
      /refusing to overwrite/,
    );
    await ensureReleaseAssets(
      [files[0]],
      [{ ...existing[0], digest: undefined }],
      upload,
      download,
    );
    await assert.rejects(
      ensureReleaseAssets(
        [files[0]],
        [{ ...existing[0], digest: undefined }],
        upload,
        async () => Buffer.from("bad"),
      ),
      /refusing to overwrite/,
    );
  });
});

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const platforms = ["darwin-arm64", "linux-x64", "win32-x64"];

export function releaseAssets(directory, version) {
  const archives = platforms.map(
    (platform) => `typed-ski-${version}-${platform}.tar.gz`,
  );
  const names = readdirSync(directory)
    .filter((name) => !["SHA256SUMS", "SHA512SUMS"].includes(name))
    .sort();
  if (JSON.stringify(names) !== JSON.stringify([...archives].sort())) {
    throw new Error(
      "Expected exactly one binary archive for each release platform",
    );
  }
  const describe = (name) => {
    const bytes = readFileSync(join(directory, name));
    if (!bytes.length) throw new Error(`Empty release asset: ${name}`);
    return {
      name,
      path: join(directory, name),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("hex"),
    };
  };
  const assets = archives.map(describe);
  for (const algorithm of ["sha256", "sha512"]) {
    const name = `${algorithm.toUpperCase()}SUMS`;
    writeFileSync(
      join(directory, name),
      assets.map((asset) => `${asset[algorithm]}  ${asset.name}\n`).join(""),
    );
  }
  return [...assets, describe("SHA256SUMS"), describe("SHA512SUMS")];
}

export async function ensureReleaseAssets(
  files,
  existing,
  upload,
  download,
  remove,
) {
  for (const file of files) {
    const found = existing.find((asset) => asset.name === file.name);
    if (found?.state === "starter" && found.size === 0) {
      await remove(found);
      await upload(file);
      continue;
    }
    if (!found) {
      await upload(file);
      continue;
    }
    let digest = found.digest;
    if (!digest?.startsWith("sha256:")) {
      digest = `sha256:${createHash("sha256")
        .update(await download(found))
        .digest("hex")}`;
    }
    if (
      found.state !== "uploaded" ||
      found.size !== file.size ||
      digest !== `sha256:${file.sha256}`
    ) {
      throw new Error(
        `Existing release asset differs: ${file.name}; refusing to overwrite`,
      );
    }
  }
}

export async function uploadReleaseAssets(repository, release, files) {
  const gh = (args, options = {}) =>
    execFileSync("gh", args, {
      env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN },
      maxBuffer: 256 * 1024 * 1024,
      ...options,
    });
  const existing = JSON.parse(
    gh(
      ["api", `repos/${repository}/releases/${release.id}/assets?per_page=100`],
      { encoding: "utf8" },
    ),
  );
  await ensureReleaseAssets(
    files,
    existing,
    (file) =>
      gh(
        [
          "release",
          "upload",
          release.tag_name,
          file.path,
          "--repo",
          repository,
        ],
        { stdio: "inherit" },
      ),
    (asset) =>
      gh([
        "api",
        `repos/${repository}/releases/assets/${asset.id}`,
        "-H",
        "Accept: application/octet-stream",
      ]),
    (asset) =>
      gh([
        "api",
        `repos/${repository}/releases/assets/${asset.id}`,
        "--method",
        "DELETE",
      ]),
  );
}

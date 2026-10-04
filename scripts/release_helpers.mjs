import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { buildSync } from "esbuild";
import { buildJsrJson, buildTsContent } from "./generate_version.mjs";

const releaseVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const jsFiles = ["tripc.js", "tripc.min.js", "tripc.node.js"];
const unixLauncher =
  '#!/usr/bin/env sh\nDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec node "$DIR/tripc.node.js" "$@"\n';
const windowsLauncher =
  '@echo off\r\nsetlocal\r\nnode "%~dp0tripc.node.js" %*\r\n';

function requireFile(path) {
  const stat = fs.statSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size === 0) {
    throw new Error(`Missing or empty release artifact: ${path}`);
  }
  return fs.readFileSync(path);
}

function assertExports(root, pkg) {
  if (!pkg.exports || typeof pkg.exports !== "object") {
    throw new Error("Package source exports are required");
  }
  for (const [name, path] of Object.entries(pkg.exports)) {
    if (typeof path !== "string" || !path.startsWith("./")) {
      throw new Error(`Invalid source export ${name}: ${path}`);
    }
    const resolved = resolve(root, path);
    const withinRoot = relative(root, resolved);
    if (withinRoot.startsWith("..") || resolve(root, withinRoot) !== resolved) {
      throw new Error(`Source export ${name} escapes the package: ${path}`);
    }
    requireFile(resolved);
  }
}

function snapshot(path) {
  const stat = fs.lstatSync(path, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
    throw new Error(`Release metadata must be a regular file: ${path}`);
  }
  return {
    path,
    bytes: stat ? fs.readFileSync(path) : undefined,
    mode: stat?.mode,
  };
}

function restore(file) {
  if (file.bytes === undefined) {
    fs.rmSync(file.path, { force: true });
  } else {
    fs.writeFileSync(file.path, file.bytes);
    if (process.platform !== "win32") fs.chmodSync(file.path, file.mode);
  }
}

function defaultBuild(root, version) {
  execFileSync(
    "bazel",
    [
      "build",
      "//:dist_artifacts",
      "//:jsr_generated_src",
      "//lib/shared:version_generated_src",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, RELEASE_VERSION: version },
    },
  );
}

/** Stage the exact package inputs. Build/validation failures restore metadata
 * and leave the previous dist untouched; successful staging replaces stale
 * generated files. This function never publishes, creates tags, or pushes. */
export function prepareRelease({
  root,
  version,
  stageOnly = false,
  bazelBin,
  build = defaultBuild,
  platform = process.platform,
}) {
  root = fs.realpathSync(root);
  const packagePath = join(root, "package.json");
  const metadata = [
    packagePath,
    join(root, "jsr.json"),
    join(root, "lib/shared/version.generated.ts"),
  ].map(snapshot);
  const pkg = JSON.parse(metadata[0].bytes);
  version ??= stageOnly ? pkg.version : undefined;
  if (typeof version !== "string" || !releaseVersion.test(version)) {
    throw new Error(`A valid SemVer release version is required: ${version}`);
  }
  if (stageOnly && version !== pkg.version) {
    throw new Error("Stage-only mode must use the current package version");
  }
  pkg.version = version;
  assertExports(root, pkg);

  const dist = join(root, "dist");
  const distStat = fs.lstatSync(dist, { throwIfNoEntry: false });
  if (distStat && (!distStat.isDirectory() || distStat.isSymbolicLink())) {
    throw new Error("Release dist must be a regular directory");
  }
  const temp = fs.mkdtempSync(join(root, ".release-prepare-"));
  // Only remove the generated transaction directory inside this checkout.
  assert.ok(!relative(root, temp).startsWith(".."));
  assert.ok(basename(temp).startsWith(".release-prepare-"));
  const stagedDist = join(temp, "dist");
  const previousDist = join(temp, "previous-dist");
  let replacedDist = false;
  let movedDist = false;
  try {
    if (!stageOnly) {
      fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");
      build(root, version);
    }
    bazelBin ??= execFileSync("bazel", ["info", "bazel-bin"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    bazelBin = resolve(root, bazelBin);
    const generatedJsr = requireFile(join(bazelBin, "jsr.json"));
    const generatedVersion = requireFile(
      join(bazelBin, "lib/shared/version.generated.ts"),
    );
    assert.deepEqual(
      JSON.parse(generatedJsr),
      JSON.parse(buildJsrJson(pkg)),
      "Generated JSR metadata does not match the release package",
    );
    assert.equal(
      generatedVersion.toString().replaceAll("\r\n", "\n"),
      buildTsContent(version),
      "Generated version constant is stale",
    );
    // Validate every public source entry and its runtime imports with the same
    // pinned bundler as the distribution build. Generated source is temporary
    // until validation succeeds and is restored on failure.
    fs.writeFileSync(
      join(root, "lib/shared/version.generated.ts"),
      generatedVersion,
    );
    buildSync({
      entryPoints: Object.values(pkg.exports).map((path) =>
        resolve(root, path),
      ),
      bundle: true,
      treeShaking: false,
      platform: "node",
      format: "esm",
      write: false,
      outdir: join(temp, "export-probes"),
      logLevel: "silent",
    });

    fs.mkdirSync(stagedDist);
    for (const file of [
      ...jsFiles,
      platform === "win32" ? "tripc.cmd" : "tripc",
    ]) {
      fs.writeFileSync(
        join(stagedDist, file),
        requireFile(join(bazelBin, "dist_artifacts", file)),
      );
    }
    // Bazel emits the host launcher. The published package supports both hosts.
    fs.writeFileSync(join(stagedDist, "tripc"), unixLauncher);
    fs.writeFileSync(join(stagedDist, "tripc.cmd"), windowsLauncher);
    if (process.platform !== "win32")
      fs.chmodSync(join(stagedDist, "tripc"), 0o755);
    for (const file of jsFiles) {
      const output = execFileSync(
        process.execPath,
        [join(stagedDist, file), "--version"],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
        },
      ).trim();
      assert.equal(
        output,
        `tripc v${version}`,
        `${file} embeds a stale release version`,
      );
    }
    if (distStat) {
      fs.renameSync(dist, previousDist);
      movedDist = true;
    }
    fs.renameSync(stagedDist, dist);
    replacedDist = true;
    fs.writeFileSync(join(root, "jsr.json"), generatedJsr);
    fs.writeFileSync(
      join(root, "lib/shared/version.generated.ts"),
      generatedVersion,
    );
  } catch (error) {
    if (replacedDist) fs.renameSync(dist, stagedDist);
    if (movedDist) fs.renameSync(previousDist, dist);
    for (const file of metadata) restore(file);
    throw error;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { buildTsContent } from "./generate_version.mjs";
import { releaseIdentity } from "./release.mjs";

const { version } = releaseIdentity(process.env);
const platform = `${process.platform}-${process.arch}`;
assert.equal(platform, process.env.RELEASE_PLATFORM);
assert.ok(["linux-x64", "darwin-arm64", "win32-x64"].includes(platform));
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "release-assets");
const temp = mkdtempSync(join(tmpdir(), "typed-ski-binaries-"));
const suffix = process.platform === "win32" ? ".exe" : "";
const run = (command, args, options = {}) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...options });

try {
  const archiveRoot = `typed-ski-${version}-${platform}`;
  const stage = join(temp, archiveRoot);
  mkdirSync(stage);
  mkdirSync(output, { recursive: true });
  for (const name of ["tripc", "improvize"]) {
    const bundled = join(temp, `${name}.mjs`);
    await build({
      entryPoints: [join(root, "bin", `${name}.ts`)],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node26",
      outfile: bundled,
      plugins: [
        {
          name: "release-version",
          setup(build) {
            build.onResolve({ filter: /version\.generated\.ts$/ }, () => ({
              path: "version",
              namespace: "release",
            }));
            build.onLoad({ filter: /.*/, namespace: "release" }, () => ({
              contents: buildTsContent(version),
              loader: "ts",
            }));
          },
        },
      ],
    });
    const executable = join(stage, `${name}${suffix}`);
    const config = join(temp, `${name}.json`);
    writeFileSync(
      config,
      JSON.stringify({
        main: bundled,
        mainFormat: "module",
        output: executable,
        disableExperimentalSEAWarning: true,
        useCodeCache: false,
        useSnapshot: false,
      }),
    );
    run(process.execPath, ["--build-sea", config]);
    if (process.platform === "darwin")
      run("codesign", ["--force", "--sign", "-", executable]);
    const reported = run(executable, ["--version"], {
      cwd: temp,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    assert.equal(reported, `${name} v${version}`);
  }
  const source = join(temp, "smoke.trip");
  const llvm = join(temp, "smoke.ll");
  writeFileSync(source, "module Main\nexport main\npoly main = #u8(42)\n");
  run(join(stage, `tripc${suffix}`), ["--emit", "llvm", source, llvm], {
    cwd: temp,
  });
  assert.match(readFileSync(llvm, "utf8"), /define/);
  run(join(stage, `improvize${suffix}`), ["format", "--write", source], {
    cwd: temp,
  });
  const bazelBin = run("bazel", ["info", "bazel-bin"], {
    encoding: "utf8",
    stdio: "pipe",
  }).trim();
  copyFileSync(
    resolve(bazelBin, "consumers/thanatos/runtime", `thanatos${suffix}`),
    join(stage, `thanatos${suffix}`),
  );
  copyFileSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  const license = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!license.ok)
    throw new Error(`Cannot obtain bundled Node license: ${license.status}`);
  writeFileSync(join(stage, "NODE-LICENSE"), await license.text());
  writeFileSync(
    join(stage, "VERSION"),
    `${version}\n${process.env.GITHUB_SHA}\n`,
  );
  const tar =
    process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "tar";
  run(tar, [
    "-czf",
    join(output, `${archiveRoot}.tar.gz`),
    "-C",
    temp,
    archiveRoot,
  ]);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

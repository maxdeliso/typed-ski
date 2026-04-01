#!/usr/bin/env -S deno run -A

import { dirname, join } from "std/path";

function usage(): never {
  console.error(
    "Usage: deno run -A scripts/bazelBuildDist.ts <manifest> <tripc.js> <tripc.min.js> <tripc.node.js> <tripc-bin>",
  );
  Deno.exit(1);
}

async function copyListedFiles(
  sourceRoot: string,
  targetRoot: string,
  manifestPath: string,
): Promise<void> {
  const manifest = await Deno.readTextFile(manifestPath);
  for (const relativePath of manifest.split(/\r?\n/)) {
    if (!relativePath) continue;
    const sourcePath = join(sourceRoot, relativePath);
    const targetPath = join(targetRoot, relativePath);
    const stat = await Deno.stat(sourcePath);
    if (!stat.isFile) continue;
    await Deno.mkdir(dirname(targetPath), { recursive: true });
    await Deno.copyFile(sourcePath, targetPath);
    if (Deno.build.os !== "windows" && stat.mode !== null) {
      await Deno.chmod(targetPath, stat.mode).catch(() => {});
    }
  }
}

async function copyOutput(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  const stat = await Deno.stat(sourcePath);
  await Deno.mkdir(dirname(targetPath), { recursive: true });
  await Deno.copyFile(sourcePath, targetPath);
  if (Deno.build.os !== "windows" && stat.mode !== null) {
    await Deno.chmod(targetPath, stat.mode).catch(() => {});
  }
}

if (Deno.args.length !== 5) usage();

const [manifestPath, tripcJsOut, tripcMinJsOut, tripcNodeJsOut, tripcBinOut] =
  Deno.args;
if (
  !manifestPath || !tripcJsOut || !tripcMinJsOut || !tripcNodeJsOut ||
  !tripcBinOut
) {
  usage();
}

const sourceRoot = Deno.cwd();
const tempRoot = await Deno.makeTempDir({ prefix: "typed-ski-dist-" });
const workspaceCopy = join(tempRoot, "workspace");
const processTempDir = join(tempRoot, "temp");
const buildTempDir = join(tempRoot, "build");

await copyListedFiles(sourceRoot, workspaceCopy, manifestPath);
await Deno.mkdir(processTempDir, { recursive: true });
await Deno.mkdir(buildTempDir, { recursive: true });

const childEnv: Record<string, string> = {
  ...Deno.env.toObject(),
  TYPED_SKI_BUILD_TEMP_DIR: buildTempDir,
  TEMP: processTempDir,
  TMP: processTempDir,
};

const { code } = await new Deno.Command(
  Deno.execPath(),
  {
    args: ["run", "-A", "scripts/bazel.ts", "dist"],
    cwd: workspaceCopy,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: childEnv,
  },
).output();

if (code !== 0) {
  Deno.exit(code);
}

await copyOutput(join(workspaceCopy, "dist", "tripc.js"), tripcJsOut);
await copyOutput(join(workspaceCopy, "dist", "tripc.min.js"), tripcMinJsOut);
await copyOutput(join(workspaceCopy, "dist", "tripc.node.js"), tripcNodeJsOut);
await copyOutput(
  join(
    workspaceCopy,
    "dist",
    Deno.build.os === "windows" ? "tripc.exe" : "tripc",
  ),
  tripcBinOut,
);

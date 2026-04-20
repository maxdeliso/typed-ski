import { dirname, join, resolve } from "node:path";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import { pathToFileURL } from "node:url";

function usage(): never {
  console.error(
    "Usage: node scripts/bazelBuildDist.js <manifest> <tripc.js> <tripc.min.js> <tripc.node.js> <arenaWorker.js> <tripc-bin>",
  );
  process.exit(1);
}

async function copyListedFiles(
  targetRoot: string,
  manifestPath: string,
): Promise<void> {
  const manifest = await fsp.readFile(manifestPath, "utf8");
  for (const line of manifest.split(/\r?\n/)) {
    if (!line) continue;
    const [sourcePath, relativePath] = line.split("\t");
    if (!sourcePath) continue;
    const targetPath = join(targetRoot, relativePath || sourcePath);
    try {
      const stat = await fsp.stat(sourcePath);
      if (!stat.isFile()) continue;
      await fsp.mkdir(dirname(targetPath), { recursive: true });
      await fsp.copyFile(sourcePath, targetPath);
      if (process.platform !== "win32") {
        await fsp.chmod(targetPath, stat.mode);
      }
    } catch (e) {
      console.error(`Failed to copy ${sourcePath} to ${targetPath}:`, e);
      throw e;
    }
  }
}

async function copyOutput(
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  const stat = await fsp.stat(sourcePath);
  await fsp.mkdir(dirname(targetPath), { recursive: true });
  await fsp.copyFile(sourcePath, targetPath);
  if (process.platform !== "win32") {
    await fsp.chmod(targetPath, stat.mode);
  }
}

if (process.argv.length !== 8) usage();

const [
  ,
  ,
  manifestPath,
  tripcJsOut,
  tripcMinJsOut,
  tripcNodeJsOut,
  arenaWorkerJsOut,
  tripcBinOut,
] = process.argv;

if (
  !manifestPath ||
  !tripcJsOut ||
  !tripcMinJsOut ||
  !tripcNodeJsOut ||
  !arenaWorkerJsOut ||
  !tripcBinOut
) {
  usage();
}

const sourceRoot = process.cwd();
const tempRoot = await fsp.mkdtemp(join(os.tmpdir(), "typed-ski-dist-"));
const workspaceCopy = join(tempRoot, "workspace");
const processTempDir = join(tempRoot, "temp");
const buildTempDir = join(tempRoot, "build");
const tripcJsOutputPath = resolve(sourceRoot, tripcJsOut);
const tripcMinJsOutputPath = resolve(sourceRoot, tripcMinJsOut);
const tripcNodeJsOutputPath = resolve(sourceRoot, tripcNodeJsOut);
const arenaWorkerJsOutputPath = resolve(sourceRoot, arenaWorkerJsOut);
const tripcBinOutputPath = resolve(sourceRoot, tripcBinOut);

await fsp.mkdir(workspaceCopy, { recursive: true });
await copyListedFiles(workspaceCopy, manifestPath);
await fsp.mkdir(processTempDir, { recursive: true });
await fsp.mkdir(buildTempDir, { recursive: true });

const childEnv = {
  ...process.env,
  TYPED_SKI_BUILD_TEMP_DIR: buildTempDir,
  TEMP: processTempDir,
  TMP: processTempDir,
};
Object.assign(process.env, childEnv);
process.chdir(workspaceCopy);

const importPath = pathToFileURL(join(workspaceCopy, "scripts", "bazel.ts")).href;
const { buildDist } = (await import(importPath)) as typeof import("./bazel.ts");
await buildDist();

await copyOutput(join(workspaceCopy, "dist", "tripc.js"), tripcJsOutputPath);
await copyOutput(
  join(workspaceCopy, "dist", "tripc.min.js"),
  tripcMinJsOutputPath,
);
await copyOutput(
  join(workspaceCopy, "dist", "tripc.node.js"),
  tripcNodeJsOutputPath,
);
await copyOutput(
  join(workspaceCopy, "dist", "arenaWorker.js"),
  arenaWorkerJsOutputPath,
);
await copyOutput(
  join(
    workspaceCopy,
    "dist",
    process.platform === "win32" ? "tripc.cmd" : "tripc",
  ),
  tripcBinOutputPath,
);

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");

const COMPILED_TRIPC_NAME = process.platform === "win32" ? "tripc.cmd" : "tripc";

async function run(args) {
  const [command, ...rest] = args;
  const result = spawnSync(command, rest, {
    cwd: PROJECT_ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}: ${args.join(" ")}`);
  }
}

async function main() {
  await fs.mkdir(join(PROJECT_ROOT, "dist"), { recursive: true });

  console.log("Bundling tripc.js...");
  await run(["pnpm", "exec", "esbuild", "bin/tripc.ts", "--bundle", "--outfile=dist/tripc.js", "--format=esm", "--platform=node"]);

  console.log("Bundling tripc.min.js...");
  await run(["pnpm", "exec", "esbuild", "bin/tripc.ts", "--bundle", "--minify", "--outfile=dist/tripc.min.js", "--format=esm", "--platform=node"]);

  console.log("Bundling tripc.node.js...");
  await run(["pnpm", "exec", "esbuild", "bin/tripc.ts", "--bundle", "--outfile=dist/tripc.node.js", "--format=esm", "--platform=node"]);

  const wrapperPath = join(PROJECT_ROOT, "dist", COMPILED_TRIPC_NAME);
  if (process.platform === "win32") {
    await fs.writeFile(wrapperPath, '@echo off\r\nsetlocal\r\nnode "%~dp0tripc.node.js" %*\r\n', "utf8");
  } else {
    await fs.writeFile(wrapperPath, '#!/usr/bin/env sh\nDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec node "$DIR/tripc.node.js" "$@"\n', "utf8");
    await fs.chmod(wrapperPath, 0o755);
  }
  console.log(`Created ${COMPILED_TRIPC_NAME} launcher.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

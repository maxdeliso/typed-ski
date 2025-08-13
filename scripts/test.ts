import { dirname, fromFileUrl } from "https://deno.land/std@0.224.0/path/mod.ts";

const projectRoot = dirname(dirname(fromFileUrl(import.meta.url)));

async function buildWasm() {
  // Build debug version
  const debugCmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:assemblyscript@latest/asc",
      "assembly/index.ts",
      "--config",
      "assembly/asconfig.json",
      "--target",
      "debug",
    ],
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit",
  });

  const { success: debugSuccess } = await debugCmd.output();
  if (!debugSuccess) throw new Error("AssemblyScript debug build failed");

  // Build release version
  const releaseCmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:assemblyscript@latest/asc",
      "assembly/index.ts",
      "--config",
      "assembly/asconfig.json",
      "--target",
      "release",
    ],
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit",
  });

  const { success: releaseSuccess } = await releaseCmd.output();
  if (!releaseSuccess) throw new Error("AssemblyScript release build failed");
}

async function runTests() {
  const cmd = new Deno.Command("deno", {
    args: [
      "test",
      "--allow-read",
      "test/",
    ],
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit",
  });

  const { success } = await cmd.output();
  if (!success) {
    throw new Error("Tests failed");
  }
}

await buildWasm();
await runTests();

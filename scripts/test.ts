import { dirname, fromFileUrl } from "https://deno.land/std/path/mod.ts";

const projectRoot = dirname(dirname(fromFileUrl(import.meta.url)));

async function buildWasm() {
  const ascCmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "npm:assemblyscript@0.28.1/asc",
      "assembly/index.ts",
      "--target",
      "debug",
    ],
    cwd: projectRoot,
    stdout: "inherit",
    stderr: "inherit",
  });

  const { success } = await ascCmd.output();
  if (!success) throw new Error("AssemblyScript build failed");
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

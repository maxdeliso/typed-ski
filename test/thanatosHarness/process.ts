import { PROJECT_ROOT, THANATOS_BIN } from "./config.ts";
import { spawn } from "node:child_process";

export async function runThanatosProcess(
  args: string[],
  input = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(THANATOS_BIN, args, {
    cwd: PROJECT_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (input.length > 0) {
    child.stdin.write(input);
  }
  child.stdin.end();

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (data) => {
    stdout += data.toString();
  });

  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  const code = await new Promise<number>((resolve) => {
    child.on("close", (code) => {
      resolve(code ?? 0);
    });
  });

  return {
    code,
    stdout,
    stderr,
  };
}

export function normalizeCliOutput(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

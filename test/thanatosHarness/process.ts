import { PROJECT_ROOT, THANATOS_BIN } from "./config.ts";

export async function runThanatosProcess(
  args: string[],
  input = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = new Deno.Command(THANATOS_BIN, {
    args,
    cwd: PROJECT_ROOT,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const writer = child.stdin.getWriter();
  if (input.length > 0) {
    await writer.write(new TextEncoder().encode(input));
  }
  await writer.close();

  const [status, stdout, stderr] = await Promise.all([
    child.status,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return {
    code: status.code,
    stdout,
    stderr,
  };
}

export function normalizeCliOutput(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

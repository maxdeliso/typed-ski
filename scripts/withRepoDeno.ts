#!/usr/bin/env -S deno run -A

import { execWithRepoDeno, getRequiredDenoVersion } from "./repoDeno.ts";

if (Deno.args.length === 0) {
  console.error(`Usage: deno run -A scripts/withRepoDeno.ts <deno-args...>

This launcher ensures Bazel commands run with Deno ${getRequiredDenoVersion()}
from deno.jsonc, bootstrapping it into a local toolchain cache when needed.`);
  Deno.exit(1);
}

await execWithRepoDeno(Deno.args);

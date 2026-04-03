import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultWorkerCount,
  startThanatosBatchBroker,
  thanatosAvailable,
} from "./thanatosHarness.ts";

const HARNESS_TRACE_TIMEOUT_MS = "200";

type GlobalHarnessState = {
  close: () => Promise<void>;
  ownedTraceDir: string | null;
};

let state: GlobalHarnessState | null = null;

export async function globalSetup(): Promise<void> {
  if (!thanatosAvailable()) {
    return;
  }

  const existingTraceDir = process.env["THANATOS_TRACE_DIR"];
  const traceDir =
    existingTraceDir ?? (await mkdtemp(join(tmpdir(), "typed-ski-thanatos-")));

  const broker = await startThanatosBatchBroker({
    workers: defaultWorkerCount(),
    env: {
      THANATOS_TRACE_DIR: traceDir,
      THANATOS_TRACE_TIMEOUT_MS: HARNESS_TRACE_TIMEOUT_MS,
    },
  });

  Object.assign(process.env, broker.env);
  process.env["THANATOS_TRACE_DIR"] = traceDir;
  process.env["THANATOS_TRACE_TIMEOUT_MS"] = HARNESS_TRACE_TIMEOUT_MS;

  state = {
    close: broker.close,
    ownedTraceDir: existingTraceDir === undefined ? traceDir : null,
  };
}

export async function globalTeardown(): Promise<void> {
  if (state === null) {
    return;
  }

  const { close, ownedTraceDir } = state;
  state = null;

  await close().catch(() => {});

  if (ownedTraceDir !== null) {
    await rm(ownedTraceDir, { recursive: true, force: true }).catch(() => {});
  }
}

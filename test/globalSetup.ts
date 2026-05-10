import {
  defaultWorkerCount,
  thanatosAvailable,
} from "./thanatosHarness/config.ts";
import { startThanatosBatchBroker } from "./thanatosHarness/session.ts";

let state: { close: () => Promise<void> } | null = null;

export async function globalSetup(): Promise<void> {
  if (!thanatosAvailable()) {
    return;
  }

  const broker = await startThanatosBatchBroker({
    workers: defaultWorkerCount(),
    env: {},
  });

  Object.assign(process.env, broker.env);

  state = {
    close: broker.close,
  };
}

export async function globalTeardown(): Promise<void> {
  if (state === null) {
    return;
  }

  const { close } = state;
  state = null;

  await close().catch(() => {});
}

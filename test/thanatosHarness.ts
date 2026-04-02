/**
 * Shared Thanatos test harness helpers.
 * Keep test definitions in thanatosHarness.test.ts so importers do not
 * accidentally register that whole suite.
 */

export {
  defaultWorkerCount,
  PROJECT_ROOT,
  THANATOS_BIN,
  thanatosAvailable,
} from "./thanatosHarness/config.ts";
export {
  normalizeCliOutput,
  runThanatosProcess,
} from "./thanatosHarness/process.ts";
export {
  closeBatchThanatosSessions,
  getBatchBrokerEnvVarNames,
  getThanatosSession,
  startThanatosBatchBroker,
  withBatchThanatosSession,
} from "./thanatosHarness/session.ts";
export type { ThanatosSession } from "./thanatosHarness/session.ts";
export {
  passthroughEvaluator,
  runThanatosBatch,
} from "./thanatosHarness/batch.ts";

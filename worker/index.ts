// worker/index.ts
//
// Production worker entry point. Run with `npm run worker`. Independent of
// Next.js: it loads configuration, connects to the database and processes jobs
// until it receives SIGINT/SIGTERM.
import "dotenv/config";

import { WorkerConfigError } from "../lib/worker/config";
import { startWorker } from "../lib/worker/bootstrap";
import { createLogger } from "../lib/worker/logger";

async function main() {
  const worker = await startWorker();
  await worker.done;
}

main().catch((error) => {
  const logger = createLogger({ level: "error", bindings: { service: "worker" } });
  if (error instanceof WorkerConfigError) {
    logger.error("invalid worker configuration", { event: "config_invalid", problems: error.problems });
  } else {
    logger.error("worker failed to start", { event: "startup_failed", error });
  }
  process.exit(1);
});

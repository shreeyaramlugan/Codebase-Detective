// lib/worker/bootstrap.ts
//
// Builds and runs a worker: validates configuration, wires the Prisma queue and
// the handlers, serves /healthz and /readyz, and shuts down gracefully. The
// process entry point (worker/index.ts) is a few lines on top of this so the
// whole startup/shutdown path is testable with injected dependencies.
import { createServer, type Server } from "node:http";

import { createLogger, type Logger } from "./logger";
import { loadWorkerConfig, type WorkerConfig } from "./config";
import { createHandlers } from "./handlers";
import { createPrismaPorts, type PipelinePorts } from "./pipeline-ports";
import { createPrismaQueue } from "./queue.prisma";
import { WorkerRuntime, type HandlerRegistry, type WorkerQueuePort } from "./runtime";

export interface BootstrapOverrides {
  queue?: WorkerQueuePort;
  ports?: PipelinePorts;
  handlers?: HandlerRegistry;
  logger?: Logger;
  /** Set false in tests so no process listeners are installed. */
  installSignalHandlers?: boolean;
  /** Called instead of process.exit in tests. */
  exit?: (code: number) => void;
}

export interface RunningWorker {
  runtime: WorkerRuntime;
  config: WorkerConfig;
  server: Server | null;
  /** Resolves when the run loop has ended. */
  done: Promise<void>;
  shutdown(reason: string): Promise<void>;
}

export function startHealthServer(runtime: WorkerRuntime, config: WorkerConfig, logger: Logger): Promise<Server | null> {
  if (config.healthPort === 0) return Promise.resolve(null);
  const server = createServer((req, res) => {
    const health = runtime.health();
    const path = (req.url ?? "").split("?")[0];
    let status = 404;
    let body: unknown = { error: "Not found" };
    if (path === "/healthz") {
      status = health.live ? 200 : 503;
      body = { status: health.live ? "ok" : "unhealthy", state: health.state };
    } else if (path === "/readyz") {
      status = health.ready ? 200 : 503;
      body = {
        status: health.ready ? "ready" : "not_ready",
        state: health.state,
        activeJobs: health.activeJobs,
        concurrency: health.concurrency,
        paused: health.paused,
        lastPollAt: health.lastPollAt,
        consecutivePollFailures: health.consecutivePollFailures,
      };
    }
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.healthPort, config.healthHost, () => {
      logger.info("health server listening", {
        event: "health_listening",
        host: config.healthHost,
        port: config.healthPort,
      });
      resolve(server);
    });
  });
}

export async function startWorker(
  env: NodeJS.ProcessEnv = process.env,
  overrides: BootstrapOverrides = {},
): Promise<RunningWorker> {
  const { config, warnings } = loadWorkerConfig(env);
  const logger = overrides.logger ?? createLogger({ level: config.logLevel, bindings: { service: "worker" } });
  for (const w of warnings) logger.warn(w, { event: "config_warning" });

  const queue = overrides.queue ?? createPrismaQueue();
  const handlers = overrides.handlers ?? createHandlers(overrides.ports ?? createPrismaPorts());
  const runtime = new WorkerRuntime({ config, queue, handlers, logger });
  const exit = overrides.exit ?? ((code: number) => process.exit(code));

  let server: Server | null = null;
  let shuttingDown: Promise<void> | null = null;

  const shutdown = (reason: string): Promise<void> => {
    shuttingDown ??= (async () => {
      await runtime.stop(reason);
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    })();
    return shuttingDown;
  };

  if (overrides.installSignalHandlers !== false) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void shutdown(signal).then(() => exit(0));
      });
    }
    process.on("unhandledRejection", (reason) => {
      logger.error("unhandled rejection", { event: "unhandled_rejection", error: reason });
    });
    process.on("uncaughtException", (error) => {
      logger.error("uncaught exception; shutting down", { event: "uncaught_exception", error });
      void shutdown("uncaughtException").finally(() => exit(1));
    });
  }

  // start() verifies the database, registers the worker, then loops until stop().
  const done = runtime.start();
  // Surface a startup failure (for example the database being unreachable) to the caller.
  const started = new Promise<void>((resolve, reject) => {
    const poll = setInterval(() => {
      const state = runtime.health().state;
      if (state !== "starting") {
        clearInterval(poll);
        resolve();
      }
    }, 10);
    done.catch((error) => {
      clearInterval(poll);
      reject(error);
    });
  });
  await started;

  server = await startHealthServer(runtime, config, logger);
  return { runtime, config, server, done, shutdown };
}

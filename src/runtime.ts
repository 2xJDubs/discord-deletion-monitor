import type { EventEmitter } from "node:events";
import type { LogLevel } from "./config.js";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export type JsonLogger = (event: string, fields?: Record<string, unknown>, level?: LogLevel) => void;

function normalize(value: unknown): unknown {
  if (value instanceof Error) return value.message;
  if (typeof value === "bigint") return value.toString();
  return value;
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createJsonLogger(
  minimumLevel: LogLevel,
  write: (line: string) => void = (line) => console.log(line),
  now: () => Date = () => new Date(),
): JsonLogger {
  return (event, fields = {}, level = "info") => {
    if (LEVELS[level] < LEVELS[minimumLevel]) return;
    const normalized = Object.fromEntries(Object.entries(fields)
      .filter(([key]) => !["timestamp", "level", "event"].includes(key))
      .map(([key, value]) => [key, normalize(value)]));
    write(JSON.stringify({ timestamp: now().toISOString(), level, event, ...normalized }));
  };
}

export function safeAsyncHandler<Args extends unknown[]>(
  event: string,
  handler: (...args: Args) => Promise<void> | void,
  log: JsonLogger,
): (...args: Args) => Promise<void> {
  return async (...args) => {
    try {
      await handler(...args);
    } catch (error) {
      log("event_handler_failed", { event, error: errorMessage(error) }, "error");
    }
  };
}

export class ActiveWorkTracker {
  private accepting = true;
  private readonly active = new Set<Promise<unknown>>();

  run(work: () => Promise<unknown> | unknown): Promise<boolean> {
    if (!this.accepting) return Promise.resolve(false);
    const task = Promise.resolve().then(work);
    this.active.add(task);
    const cleanup = () => this.active.delete(task);
    task.then(cleanup, cleanup);
    return task.then(() => true);
  }

  stopAccepting(): void { this.accepting = false; }

  async drain(timeoutMs: number): Promise<boolean> {
    if (!this.active.size) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const settled = Promise.allSettled([...this.active]).then(() => true as const);
    const result = await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }
}

type SignalSource = Pick<EventEmitter, "on">;
type ClientLike = { destroy(): void | Promise<void> };
type StoreLike = { close(): unknown };

export function installGracefulShutdown(
  client: ClientLike,
  store: StoreLike,
  log: JsonLogger,
  signals: SignalSource = process,
  stop: () => void = () => undefined,
  options: { work?: ActiveWorkTracker; drainTimeoutMs?: number } = {},
): (signal: "SIGINT" | "SIGTERM") => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      log("shutdown_started", { signal });
      options.work?.stopAccepting();
      try { stop(); } catch (error) { log("shutdown_step_failed", { step: "stop_timers", error: errorMessage(error) }, "error"); }
      let drained = true;
      if (options.work) {
        const timeoutMs = options.drainTimeoutMs ?? 30_000;
        drained = await options.work.drain(timeoutMs);
        if (!drained) log("shutdown_drain_timeout", { timeoutMs }, "warn");
      }
      try { await client.destroy(); } catch (error) { log("shutdown_step_failed", { step: "discord_destroy", error: errorMessage(error) }, "error"); }
      if (drained) {
        try { store.close(); } catch (error) { log("shutdown_step_failed", { step: "database_close", error: errorMessage(error) }, "error"); }
      } else {
        log("shutdown_database_left_open", { activeWorkMayRemain: true }, "error");
      }
      log("shutdown_complete", { signal });
    })();
    return shutdownPromise;
  };
  signals.on("SIGINT", () => { void shutdown("SIGINT"); });
  signals.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  return shutdown;
}

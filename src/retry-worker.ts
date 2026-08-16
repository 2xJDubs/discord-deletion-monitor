import type { JsonLogger } from "./runtime.js";

type PendingMessage = { message_id: string; guild_id: string };
type RetryWorkerOptions = {
  listDuePending(now: Date, limit: number): PendingMessage[];
  deliver(guildId: string, messageId: string): Promise<boolean>;
  intervalMs: number;
  batchSize: number;
  runWork(work: () => Promise<void>): Promise<boolean>;
  log: JsonLogger;
};

export type DeliveryRetryWorker = {
  start(): void;
  runNow(): Promise<void>;
  stop(): void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDeliveryRetryWorker(options: RetryWorkerOptions): DeliveryRetryWorker {
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const runNow = (): Promise<void> => {
    if (stopped || running) return Promise.resolve();
    running = (async () => {
      try {
        await options.runWork(async () => {
          const pending = options.listDuePending(new Date(), options.batchSize);
          for (const message of pending) await options.deliver(message.guild_id, message.message_id);
        });
      } catch (error) {
        options.log("delivery_retry_failed", { error: errorMessage(error) }, "error");
      } finally {
        running = undefined;
      }
    })();
    return running;
  };

  return {
    start(): void {
      if (stopped || timer) return;
      void runNow();
      timer = setInterval(() => { void runNow(); }, options.intervalMs);
      timer.unref();
    },
    runNow,
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

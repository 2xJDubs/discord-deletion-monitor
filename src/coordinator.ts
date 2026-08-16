import type { AttachmentSource } from "./attachments.js";
import { captureMessage, type MessageSnapshot } from "./capture.js";
import type { StoredAttachment, StoredMessage } from "./database.js";

type CaptureStore = { save(message: StoredMessage, attachments: StoredAttachment[]): void };
type AttachmentDownloader = (messageId: string, attachments: AttachmentSource[], signal?: AbortSignal) => Promise<StoredAttachment[]>;
type QueueItem = { snapshot: MessageSnapshot; resolve: (accepted: boolean) => void; reject: (error: unknown) => void };

/** Coordinates create/delete races while bounding all attachment capture work. */
export class CaptureCoordinator {
  private readonly queue: QueueItem[] = [];
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private readonly controllers = new Set<AbortController>();
  private active = 0;
  private accepting = true;

  constructor(
    private readonly store: CaptureStore,
    private readonly download: AttachmentDownloader,
    private readonly limits: { concurrency: number; maxQueued: number },
  ) {}

  capture(snapshot: MessageSnapshot): Promise<boolean> {
    if (!this.accepting) return Promise.resolve(false);
    let task: Promise<boolean>;
    if (this.active < this.limits.concurrency) {
      task = this.run(snapshot);
    } else if (this.queue.length < this.limits.maxQueued) {
      task = new Promise<boolean>((resolve, reject) => this.queue.push({ snapshot, resolve, reject }));
    } else {
      task = this.saveTextOnly(snapshot);
    }
    this.inFlight.set(snapshot.messageId, task);
    const cleanup = () => {
      if (this.inFlight.get(snapshot.messageId) === task) this.inFlight.delete(snapshot.messageId);
    };
    task.then(cleanup, cleanup);
    return task;
  }

  async afterCapture<T>(messageId: string, action: () => Promise<T> | T): Promise<T> {
    await this.inFlight.get(messageId);
    return action();
  }

  stop(): void {
    if (!this.accepting) return;
    this.accepting = false;
    for (const controller of this.controllers) controller.abort();
    for (const item of this.queue.splice(0)) this.saveTextOnly(item.snapshot).then(item.resolve, item.reject);
  }

  private async saveTextOnly(snapshot: MessageSnapshot): Promise<boolean> {
    await captureMessage(snapshot, this.store, async () => []);
    return true;
  }

  private async run(snapshot: MessageSnapshot): Promise<boolean> {
    this.active += 1;
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      await captureMessage(snapshot, this.store, (id, items) => this.download(id, items, controller.signal));
      return true;
    } finally {
      this.controllers.delete(controller);
      this.active -= 1;
      this.startNext();
    }
  }

  private startNext(): void {
    if (!this.accepting || this.active >= this.limits.concurrency) return;
    const next = this.queue.shift();
    if (!next) return;
    this.run(next.snapshot).then(next.resolve, next.reject);
  }
}

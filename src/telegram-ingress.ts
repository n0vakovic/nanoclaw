import fs from 'node:fs';
import path from 'node:path';

export class IngressPersistenceError extends Error {
  constructor() {
    super('Telegram update could not be durably journaled');
    this.name = 'IngressPersistenceError';
  }
}

export interface IngressUpdate {
  update_id: number;
  message?: { text?: string };
  callback_query?: unknown;
}

export function isImmediateTelegramUpdate(update: IngressUpdate): boolean {
  return (
    update.callback_query !== undefined ||
    /^\/(?:status|jobs|cancel|clear|restart|steer|approve|reject|ping|chatid)(?:@[A-Za-z0-9_]+)?(?:\s|$)/i.test(
      update.message?.text || '',
    )
  );
}

/** Durable FIFO for ordinary updates. Recovery commands never wait for its worker. */
export class TelegramIngress<T extends IngressUpdate> {
  private processing = new WeakSet<object>();
  private queue: Array<{
    file: string;
    update: T;
    receivedAt: number;
    attempts?: number;
  }> = [];
  private known = new Set<number>();
  private running = false;
  private started = false;
  private stopped = false;
  private retryTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private directory: string,
    private dispatch: (update: T) => Promise<void>,
    private onError: (error: unknown) => void,
    private retryMs = 30_000,
    private onFailure?: (update: T) => Promise<void>,
  ) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const filename of fs.readdirSync(directory)) {
      if (!/^\d+\.json$/.test(filename)) continue;
      const file = path.join(directory, filename);
      if (fs.existsSync(file.replace(/\.json$/, '.done'))) {
        fs.unlinkSync(file);
        continue;
      }
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          update: T;
          receivedAt: number;
        };
        if (
          !Number.isSafeInteger(record.update?.update_id) ||
          record.update.update_id < 0 ||
          filename !== `${record.update.update_id}.json` ||
          !Number.isFinite(record.receivedAt)
        )
          throw new Error('Invalid Telegram ingress record');
        this.known.add(record.update.update_id);
        this.queue.push({ ...record, file });
      } catch (error) {
        // Quarantine poison evidence without preventing host recovery controls.
        onError(error);
        fs.renameSync(file, file.replace(/\.json$/, '.corrupt'));
      }
    }
    this.queue.sort(
      (a, b) =>
        a.receivedAt - b.receivedAt || a.update.update_id - b.update.update_id,
    );
  }

  /** Register as the first grammY middleware. Worker reentry runs normal handlers. */
  async handle(update: T, next: () => Promise<void>): Promise<void> {
    if (this.processing.has(update) || isImmediateTelegramUpdate(update)) {
      await next();
      return;
    }
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0)
      throw new Error('Invalid Telegram update ID');
    if (
      this.known.has(update.update_id) ||
      fs.existsSync(path.join(this.directory, `${update.update_id}.done`)) ||
      fs.existsSync(path.join(this.directory, `${update.update_id}.failed`))
    )
      return;
    const file = path.join(this.directory, `${update.update_id}.json`);
    const receivedAt = Date.now();
    const temporary = `${file}.tmp`;
    try {
      const fd = fs.openSync(temporary, 'w', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ receivedAt, update }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, file);
      this.syncDirectory();
    } catch {
      // Polling must stop before Telegram can acknowledge this uncommitted update.
      throw new IngressPersistenceError();
    }
    this.known.add(update.update_id);
    this.queue.push({ file, update, receivedAt });
    this.kick();
  }

  start(): void {
    this.started = true;
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  private syncDirectory(): void {
    const fd = fs.openSync(this.directory, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private kick(): void {
    if (!this.started || this.stopped || this.running || this.retryTimer)
      return;
    this.running = true;
    void this.drain()
      .catch((error) => {
        this.scheduleRetry();
        this.onError(error);
      })
      .finally(() => {
        this.running = false;
        if (this.queue.length) this.kick();
      });
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.kick();
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.queue.length) {
      const record = this.queue[0];
      try {
        this.processing.add(record.update);
        await this.dispatch(record.update);
        const receipt = record.file.replace(/\.json$/, '.done');
        const fd = fs.openSync(receipt, 'w', 0o600);
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        this.syncDirectory();
        fs.unlinkSync(record.file);
        this.syncDirectory();
        this.queue.shift();
        this.known.delete(record.update.update_id);
      } catch (error) {
        this.onError(error);
        record.attempts = (record.attempts || 0) + 1;
        if (record.attempts >= 2) {
          fs.renameSync(record.file, record.file.replace(/\.json$/, '.failed'));
          this.syncDirectory();
          this.queue.shift();
          this.known.delete(record.update.update_id);
          try {
            await this.onFailure?.(record.update);
          } catch (notifyError) {
            this.onError(notifyError);
          }
          continue;
        }
        const fd = fs.openSync(`${record.file}.tmp`, 'w', 0o600);
        try {
          fs.writeFileSync(
            fd,
            JSON.stringify({
              update: record.update,
              receivedAt: record.receivedAt,
              attempts: record.attempts,
            }),
          );
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(`${record.file}.tmp`, record.file);
        this.syncDirectory();
        this.scheduleRetry();
        return;
      } finally {
        this.processing.delete(record.update);
      }
    }
  }
}

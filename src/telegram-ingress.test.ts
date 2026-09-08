import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TelegramIngress,
  IngressPersistenceError,
  type IngressUpdate,
} from './telegram-ingress.js';

let directory: string;
const queues: TelegramIngress<IngressUpdate>[] = [];
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function make(
  dispatch: (update: IngressUpdate) => Promise<void>,
  onError = vi.fn(),
) {
  const ingress = new TelegramIngress(directory, dispatch, onError, 1000);
  queues.push(ingress);
  return ingress;
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-ingress-'));
});
afterEach(() => {
  for (const q of queues.splice(0)) q.stop();
  fs.rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('durable Telegram ingress', () => {
  it('lets status bypass stalled ordinary work, preserving serial ordinary order', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: number[] = [];
    const queue = make(async (update) => {
      seen.push(update.update_id);
      if (update.update_id === 1) await wait;
    });
    queue.start();
    await queue.handle({ update_id: 1 }, async () => {});
    await queue.handle({ update_id: 2 }, async () => {});
    const status = vi.fn(async () => {});
    await queue.handle({ update_id: 3, message: { text: '/status' } }, status);
    expect(status).toHaveBeenCalledOnce();
    expect(seen).toEqual([1]);
    expect(fs.existsSync(path.join(directory, '1.json'))).toBe(true);
    release();
    await settle();
    expect(seen).toEqual([1, 2]);
    expect(fs.existsSync(path.join(directory, '2.done'))).toBe(true);
  });

  it('replays startup journal once and persistently deduplicates completed updates', async () => {
    const first = make(vi.fn(async () => {}));
    await first.handle({ update_id: 8 }, async () => {});
    await first.handle({ update_id: 8 }, async () => {});
    first.stop();
    const dispatch = vi.fn(async () => {});
    const replay = make(dispatch);
    replay.start();
    await settle();
    expect(dispatch).toHaveBeenCalledTimes(1);
    replay.stop();
    const restartedDispatch = vi.fn(async () => {});
    const restarted = make(restartedDispatch);
    restarted.start();
    await restarted.handle({ update_id: 8 }, async () => {});
    await settle();
    expect(restartedDispatch).not.toHaveBeenCalled();
  });

  it('retains failed work and retries in order without blocking controls', async () => {
    vi.useFakeTimers();
    const error = vi.fn();
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const queue = make(dispatch, error);
    queue.start();
    await queue.handle({ update_id: 1 }, async () => {});
    await settle();
    await queue.handle({ update_id: 2 }, async () => {});
    expect(fs.existsSync(path.join(directory, '1.json'))).toBe(true);
    expect(fs.existsSync(path.join(directory, '1.done'))).toBe(false);
    const control = vi.fn(async () => {});
    await queue.handle({ update_id: 3, callback_query: {} }, control);
    expect(control).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(dispatch.mock.calls.map(([u]) => u.update_id)).toEqual([1, 1, 2]);
    expect(error).toHaveBeenCalledOnce();
  });

  it('reenters normal middleware only for the worker object, without journaling again', async () => {
    const handler = vi.fn(async () => {});
    let queue!: TelegramIngress<IngressUpdate>;
    queue = make((update) => queue.handle(update, handler));
    queue.start();
    await queue.handle({ update_id: 7 }, async () => {
      throw new Error('polling must not execute handler');
    });
    await settle();
    expect(handler).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(directory, '7.done'))).toBe(true);
  });
  it('quarantines a poison update after one retry and proceeds to later messages', async () => {
    vi.useFakeTimers();
    const failure = vi.fn(async () => {});
    const seen: number[] = [];
    const queue = new TelegramIngress(
      directory,
      async (update: IngressUpdate) => {
        seen.push(update.update_id);
        if (update.update_id === 1) throw new Error('poison');
      },
      vi.fn(),
      1000,
      failure,
    );
    queues.push(queue);
    queue.start();
    await queue.handle({ update_id: 1 }, async () => {});
    await queue.handle({ update_id: 2 }, async () => {});
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([1, 1, 2]);
    expect(failure).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(directory, '1.failed'))).toBe(true);
    expect(fs.existsSync(path.join(directory, '2.done'))).toBe(true);
  });
  it('quarantines corrupt startup evidence without disabling controls', async () => {
    fs.writeFileSync(path.join(directory, '9.json'), 'broken');
    const error = vi.fn();
    const queue = make(
      vi.fn(async () => {}),
      error,
    );
    queue.start();
    const control = vi.fn(async () => {});
    await queue.handle(
      { update_id: 10, message: { text: '/status' } },
      control,
    );
    expect(control).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(directory, '9.corrupt'), 'utf8')).toBe(
      'broken',
    );
  });

  it('backs off rather than busy looping when failure journaling cannot write', async () => {
    vi.useFakeTimers();
    const dispatch = vi.fn(async () => {
      throw new Error('failed');
    });
    const queue = make(dispatch);
    await queue.handle({ update_id: 1 }, async () => {});
    const write = vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw new Error('disk unavailable');
    });
    queue.start();
    await settle();
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(dispatch).toHaveBeenCalledTimes(1);
    queue.stop();
    write.mockRestore();
  });
  it('fails closed when the initial durable commit cannot be written', async () => {
    const dispatch = vi.fn(async () => {});
    const queue = make(dispatch);
    queue.start();
    const write = vi.spyOn(fs, 'openSync').mockImplementation(() => {
      throw new Error('disk unavailable');
    });
    await expect(
      queue.handle({ update_id: 99 }, async () => {}),
    ).rejects.toBeInstanceOf(IngressPersistenceError);
    write.mockRestore();
    expect(dispatch).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(directory, '99.done'))).toBe(false);
  });
});

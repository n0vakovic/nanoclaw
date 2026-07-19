import { describe, it, expect, vi } from 'vitest';

import {
  createHandlerTimeoutMiddleware,
  createApiTimeoutTransformer,
} from './bot-guards.js';

describe('createHandlerTimeoutMiddleware', () => {
  it('resolves (does not hang) when a handler never settles, and reports the timeout', async () => {
    const onTimeout = vi.fn();
    const mw = createHandlerTimeoutMiddleware(20, onTimeout);
    const never = () => new Promise<void>(() => {});

    // The whole point: this await must complete even though next() never does.
    await mw({}, never);

    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it('passes through a fast handler without reporting a timeout', async () => {
    const onTimeout = vi.fn();
    const mw = createHandlerTimeoutMiddleware(1000, onTimeout);
    const fast = vi.fn(() => Promise.resolve());

    await mw({}, fast);

    expect(fast).toHaveBeenCalledOnce();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('rethrows a non-timeout handler error so bot.catch still sees it', async () => {
    const mw = createHandlerTimeoutMiddleware(1000);
    const boom = () => Promise.reject(new Error('handler blew up'));

    await expect(mw({}, boom)).rejects.toThrow('handler blew up');
  });
});

describe('createApiTimeoutTransformer', () => {
  it('supplies an AbortSignal to the downstream call when none is given', async () => {
    const transformer = createApiTimeoutTransformer(5000);
    const prev = vi.fn().mockResolvedValue({ ok: true });

    await transformer(prev, 'sendMessage', { chat_id: 1 }, undefined);

    const passedSignal = prev.mock.calls[0][2];
    expect(passedSignal).toBeInstanceOf(AbortSignal);
  });

  it('preserves an existing signal instead of overriding it', async () => {
    const transformer = createApiTimeoutTransformer(5000);
    const prev = vi.fn().mockResolvedValue({ ok: true });
    const existing = AbortSignal.timeout(100);

    await transformer(prev, 'sendMessage', { chat_id: 1 }, existing);

    expect(prev.mock.calls[0][2]).toBe(existing);
  });
});

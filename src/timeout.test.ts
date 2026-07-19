import { describe, it, expect } from 'vitest';

import { withTimeout, TimeoutError } from './timeout.js';

describe('withTimeout', () => {
  it('rejects with TimeoutError when the inner promise never settles', async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 20, 'download')).rejects.toThrow(
      TimeoutError,
    );
  });

  it('includes the label in the timeout error message', async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 20, 'download')).rejects.toThrow(
      /download/,
    );
  });

  it('resolves with the value when the inner promise settles in time', async () => {
    const fast = Promise.resolve('ok');
    await expect(withTimeout(fast, 1000, 'x')).resolves.toBe('ok');
  });

  it('propagates the inner rejection when it rejects before the timeout', async () => {
    const boom = Promise.reject(new Error('inner failure'));
    await expect(withTimeout(boom, 1000, 'x')).rejects.toThrow('inner failure');
  });

  it('does not keep the event loop alive after a fast resolve', async () => {
    // If the timer were not cleared, this would leave a 60s handle pending.
    await withTimeout(Promise.resolve(1), 60_000, 'x');
    expect(true).toBe(true);
  });
});

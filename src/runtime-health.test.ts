import { beforeEach, describe, expect, it, vi } from 'vitest';

const runMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return {
    execFile: Object.assign(vi.fn(), { [promisify.custom]: runMock }),
  };
});

import { checkDocker, reconcileContainers } from './runtime-health.js';

beforeEach(() => {
  runMock.mockReset();
});

describe('asynchronous runtime health checks', () => {
  it('bounds Docker health checks without synchronously blocking the caller', async () => {
    let complete!: (value: { stdout: string }) => void;
    runMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const finished = vi.fn();
    const check = checkDocker().then(finished);
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalledWith(
      'docker',
      ['info', '--format', '{{.ServerVersion}}'],
      { timeout: 5000, maxBuffer: 64000 },
    );
    complete({ stdout: '28.0.0' });
    await check;
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it('propagates a failed or timed-out health check', async () => {
    runMock.mockRejectedValue(
      Object.assign(new Error('Docker timed out'), { code: 'ETIMEDOUT' }),
    );
    await expect(checkDocker()).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });

  it('only stops validated NanoClaw names and verifies that they are gone', async () => {
    runMock
      .mockResolvedValueOnce({
        stdout:
          'nanoclaw-main-123\nother-nanoclaw-123\nnanoclaw-\nnanoclaw-bad;touch-secret\nnanoclaw-second_1.2\n',
      })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' });
    await reconcileContainers();
    expect(runMock.mock.calls).toEqual([
      [
        'docker',
        ['ps', '--filter', 'name=nanoclaw-', '--format', '{{.Names}}'],
        { timeout: 5000, maxBuffer: 64000 },
      ],
      [
        'docker',
        ['stop', '--time', '5', 'nanoclaw-main-123'],
        { timeout: 10000, maxBuffer: 64000 },
      ],
      [
        'docker',
        ['stop', '--time', '5', 'nanoclaw-second_1.2'],
        { timeout: 10000, maxBuffer: 64000 },
      ],
      [
        'docker',
        ['ps', '--filter', 'name=nanoclaw-', '--format', '{{.Names}}'],
        { timeout: 5000, maxBuffer: 64000 },
      ],
    ]);
  });

  it('refuses startup if previous containers survive a stop attempt', async () => {
    runMock
      .mockResolvedValueOnce({ stdout: 'nanoclaw-main-123\n' })
      .mockRejectedValueOnce(new Error('Stop timed out'))
      .mockResolvedValueOnce({ stdout: 'nanoclaw-main-123\n' });
    await expect(reconcileContainers()).rejects.toThrow(
      'Previous NanoClaw containers have not stopped',
    );
    expect(runMock).toHaveBeenCalledTimes(3);
  });

  it('accepts a failed stop only when the final inventory proves the container exited', async () => {
    runMock
      .mockResolvedValueOnce({ stdout: 'nanoclaw-main-123\n' })
      .mockRejectedValueOnce(new Error('Container already exited'))
      .mockResolvedValueOnce({ stdout: '' });
    await expect(reconcileContainers()).resolves.toBeUndefined();
  });

  it('refuses reconciliation if Docker inventory cannot be read', async () => {
    runMock.mockRejectedValueOnce(new Error('Docker unavailable'));
    await expect(reconcileContainers()).rejects.toThrow('Docker unavailable');
    expect(runMock).toHaveBeenCalledTimes(1);
  });
});

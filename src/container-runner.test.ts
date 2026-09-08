import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CREDENTIAL_PROXY_PORT: 3001,
  CODING_DIR: '/tmp/nanoclaw-test-coding',
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

vi.mock('./credential-proxy.js', () => ({ detectAuthMode: () => 'oauth' }));
vi.mock('./env.js', () => ({
  readEnvFile: () => ({ TODOIST_API_KEY: 'test-secret-token' }),
}));

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import { spawn } from 'child_process';
import fs from 'fs';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });

  it('mounts cross-group sessions read-only for main containers', async () => {
    const resultPromise = runContainerAgent(
      { ...testGroup, isMain: true },
      { ...testInput, isMain: true },
      () => {},
    );

    fakeProc.emit('close', 0);
    await vi.advanceTimersByTimeAsync(10);
    await resultPromise;

    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain(
      '/tmp/nanoclaw-test-data/sessions:/workspace/group-sessions:ro',
    );
  });
});

describe('detached execution and diagnostics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.mocked(fs.writeFileSync).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('isolates execution state and input while retaining group authority', async () => {
    const promise = runContainerAgent(
      testGroup,
      { ...testInput, executionId: 'job-42' },
      () => {},
    );
    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    fakeProc.emit('close', 0);
    await promise;
    const args = vi.mocked(spawn).mock.calls[0][1] as string[];
    expect(args).toContain(
      '/tmp/nanoclaw-test-data/executions/job-42/.claude:/home/node/.claude',
    );
    expect(args).toContain(
      '/tmp/nanoclaw-test-data/executions/job-42/agent-runner-src:/app/src',
    );
    expect(args).toContain(
      '/tmp/nanoclaw-test-data/ipc/test-group/executions/job-42/input:/workspace/ipc/input',
    );
    expect(args).toContain(
      '/tmp/nanoclaw-test-data/ipc/test-group:/workspace/ipc',
    );
    expect(args).toContain(
      '/tmp/nanoclaw-test-groups/test-group:/workspace/group',
    );
    expect(args.join(' ')).not.toContain('sessions/test-group/.claude');
  });

  it.each(['../escape', '', 'a/b', 'a'.repeat(101)])(
    'rejects unsafe execution id %s before spawning',
    async (executionId) => {
      await expect(
        runContainerAgent(testGroup, { ...testInput, executionId }, () => {}),
      ).rejects.toThrow('Invalid execution');
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it('does not resume foreground sessions in a detached execution', async () => {
    await expect(
      runContainerAgent(
        testGroup,
        { ...testInput, executionId: 'job', sessionId: 'foreground' },
        () => {},
      ),
    ).rejects.toThrow('cannot resume');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('progress neither delivers a response nor makes an initialization timeout successful', async () => {
    const onOutput = vi.fn(async () => {});
    const onActivity = vi.fn();
    const promise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
      onActivity,
    );
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${JSON.stringify({ type: 'progress', phase: 'model', newSessionId: 'init' })}\n${OUTPUT_END_MARKER}\n`,
    );
    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    const result = await promise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('1830000ms');
    expect(onOutput).not.toHaveBeenCalled();
    expect(onActivity).toHaveBeenCalledWith('model');
  });

  it('does not accept a progress-only clean exit as a result', async () => {
    const promise = runContainerAgent(testGroup, testInput, () => {});
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${JSON.stringify({ type: 'progress', phase: 'model' })}\n${OUTPUT_END_MARKER}\n`,
    );
    fakeProc.emit('close', 0);
    expect((await promise).status).toBe('error');
  });

  it('counts an explicitly completed silent query as idle cleanup', async () => {
    const promise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      vi.fn(async () => {}),
    );
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: null,
      completed: true,
    });
    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    expect((await promise).status).toBe('success');
  });

  it('a new query after a completed result is not idle timeout cleanup', async () => {
    const promise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      vi.fn(async () => {}),
    );
    emitOutputMarker(fakeProc, { status: 'success', result: 'First response' });
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${JSON.stringify({ type: 'progress', phase: 'model' })}\n${OUTPUT_END_MARKER}\n`,
    );
    await vi.advanceTimersByTimeAsync(1830000);
    fakeProc.emit('close', 137);
    expect((await promise).status).toBe('error');
  });

  it('reports callback rejection instead of leaving completion pending', async () => {
    const promise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      async () => {
        throw new Error('delivery failed');
      },
    );
    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    fakeProc.emit('close', 0);
    expect(await promise).toMatchObject({
      status: 'error',
      error: 'Output callback failed: delivery failed',
    });
  });

  it('returns actual result after progress in nonstreaming mode and redacts diagnostics', async () => {
    const promise = runContainerAgent(testGroup, testInput, () => {});
    fakeProc.stdout.push(
      `${OUTPUT_START_MARKER}\n${JSON.stringify({ type: 'progress', phase: 'model' })}\n${OUTPUT_END_MARKER}\n`,
    );
    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    fakeProc.stderr.push('failure test-secret-token');
    fakeProc.emit('close', 1);
    expect((await promise).error).not.toContain('test-secret-token');
    const logs = vi
      .mocked(fs.writeFileSync)
      .mock.calls.map((call) => String(call[1]))
      .join('\n');
    expect(logs).not.toContain('test-secret-token');
    expect(logs).toContain('TODOIST_API_KEY=[REDACTED]');
  });

  it('recovers the next valid marker after an oversized incomplete frame', async () => {
    const onOutput = vi.fn(async () => {});
    const promise = runContainerAgent(testGroup, testInput, () => {}, onOutput);
    fakeProc.stdout.push(OUTPUT_START_MARKER + 'x'.repeat(10485761));
    emitOutputMarker(fakeProc, { status: 'success', result: 'Recovered' });
    fakeProc.emit('close', 0);
    expect((await promise).status).toBe('success');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Recovered' }),
    );
  });
});

describe('rootless Docker launch identity', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
    vi.spyOn(process, 'getuid').mockReturnValue(1234);
    vi.spyOn(process, 'getgid').mockReturnValue(5678);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function launchArgs(): Promise<string[]> {
    const result = runContainerAgent(testGroup, testInput, () => {});
    emitOutputMarker(fakeProc, { status: 'success', result: 'Done' });
    fakeProc.emit('close', 0);
    await result;
    return vi.mocked(spawn).mock.calls[0][1] as string[];
  }

  it('maps rootless container root to the host owner with the agent home and sandbox flag', async () => {
    vi.stubEnv('NANOCLAW_ROOTLESS', '1');
    const args = await launchArgs();
    expect(
      args.slice(args.indexOf('--user'), args.indexOf('--user') + 6),
    ).toEqual(['--user', '0:0', '-e', 'HOME=/home/node', '-e', 'IS_SANDBOX=1']);
    expect(args).not.toContain('1234:5678');
  });

  it('keeps host UID/GID mapping when rootless mode is absent', async () => {
    vi.stubEnv('NANOCLAW_ROOTLESS', undefined);
    const args = await launchArgs();
    expect(args[args.indexOf('--user') + 1]).toBe('1234:5678');
    expect(args).toContain('HOME=/home/node');
    expect(args).not.toContain('IS_SANDBOX=1');
  });

  it.each([0, 1000])(
    'preserves the default container identity for host UID %s without rootless mode',
    async (uid) => {
      vi.stubEnv('NANOCLAW_ROOTLESS', undefined);
      vi.mocked(process.getuid!).mockReturnValue(uid);
      const args = await launchArgs();
      expect(args).not.toContain('--user');
      expect(args).not.toContain('IS_SANDBOX=1');
    },
  );
});

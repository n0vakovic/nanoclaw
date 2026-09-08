import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runContainerAgent } from './container-runner.js';
import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeGroupSessionsIndex: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('isolates scheduled execution from foreground session and input channel', async () => {
    createTask({
      id: 'task-isolated',
      group_folder: 'main',
      chat_jid: 'chat',
      prompt: 'Research',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'group',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const proc = {} as any;
    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, onProcess, onOutput) => {
        onProcess(proc, 'nanoclaw-scheduled');
        await onOutput?.({ status: 'success', result: 'Done' });
        await new Promise<void>((resolve) => setTimeout(resolve, 11_000));
        return { status: 'success', result: 'Done' };
      },
    );
    const queue = {
      enqueueTask: vi.fn((_key, _id, fn) => {
        void fn();
      }),
      registerProcess: vi.fn(),
      closeStdin: vi.fn(),
      notifyIdle: vi.fn(),
    };
    const onProcess = vi.fn();
    const sendMessage = vi.fn(async () => {});
    startSchedulerLoop({
      registeredGroups: () => ({
        chat: {
          name: 'Main',
          folder: 'main',
          trigger: '@Ras',
          added_at: '2026-01-01',
          isMain: true,
        },
      }),
      getSessions: () => ({ main: 'foreground-session' }),
      queue: queue as any,
      onProcess,
      sendMessage,
    });
    await vi.advanceTimersByTimeAsync(11_001);
    expect(queue.enqueueTask).toHaveBeenCalledWith(
      'scheduled:task-isolated',
      'task-isolated',
      expect.any(Function),
    );
    const input = vi.mocked(runContainerAgent).mock.calls.at(-1)![1];
    expect(input.sessionId).toBeUndefined();
    expect(input.executionId).toMatch(/^scheduled-task-isolated-\d+$/);
    expect(input.groupFolder).toBe('main');
    expect(queue.registerProcess).toHaveBeenCalledWith(
      'scheduled:task-isolated',
      proc,
      'nanoclaw-scheduled',
      'main',
      `main/executions/${input.executionId}`,
    );
    expect(queue.closeStdin).toHaveBeenCalledWith('scheduled:task-isolated');
    expect(queue.notifyIdle).toHaveBeenCalledWith('scheduled:task-isolated');
    expect(onProcess).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('chat', 'Done');
  });

  it('rechecks task status after waiting for capacity', async () => {
    createTask({
      id: 'task-paused',
      group_folder: 'main',
      chat_jid: 'chat',
      prompt: 'Research',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const enqueueTask = vi.fn();
    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });
    const { updateTask } = await import('./db.js');
    updateTask('task-paused', { status: 'paused' });
    vi.mocked(runContainerAgent).mockClear();
    await enqueueTask.mock.calls[0][2]();
    expect(runContainerAgent).not.toHaveBeenCalled();
  });

  it('leaves due tasks durable while the runtime is unavailable', async () => {
    createTask({
      id: 'task-offline',
      group_folder: 'main',
      chat_jid: 'chat',
      prompt: 'Research',
      schedule_type: 'once',
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const enqueueTask = vi.fn();
    startSchedulerLoop({
      runtimeReady: () => false,
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueueTask).not.toHaveBeenCalled();
    expect(getTaskById('task-offline')?.status).toBe('active');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});

import { ChildProcess, exec, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { CONTAINER_RUNTIME_BIN, stopContainer } from './container-runtime.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 1;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
  startedAt: string | null;
  lastProgressAt: string | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  cancelling: boolean;
  completion: Promise<void> | null;
  complete: (() => void) | null;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
        startedAt: null,
        lastProgressAt: null,
        retryTimer: null,
        cancelling: false,
        completion: null,
        complete: null,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.cancelling) return;
    if (state.retryTimer) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);
    if (state.cancelling) return;

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (!this.hasBackgroundCapacity()) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
    ipcNamespace?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = ipcNamespace || groupFolder;
    if (state.cancelling) {
      void this.stopProcess(state).catch((err) =>
        logger.error(
          { groupJid, err },
          'Failed to stop late registered process',
        ),
      );
    }
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.lastProgressAt = new Date().toISOString();
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(groupJid: string, text: string): boolean {
    return this.writeInput(groupJid, text, false);
  }

  steerTask(groupJid: string, text: string): boolean {
    return this.writeInput(groupJid, text, true);
  }

  private writeInput(groupJid: string, text: string, task: boolean): boolean {
    const state = this.getGroup(groupJid);
    if (
      !state.active ||
      state.cancelling ||
      !state.groupFolder ||
      state.isTaskContainer !== task
    )
      return false;
    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.completion = new Promise<void>((resolve) => {
      state.complete = resolve;
    });
    state.startedAt = new Date().toISOString();
    state.lastProgressAt = state.startedAt;
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      state.active = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      state.complete?.();
      state.complete = null;
      state.completion = null;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.completion = new Promise<void>((resolve) => {
      state.complete = resolve;
    });
    state.startedAt = new Date().toISOString();
    state.lastProgressAt = state.startedAt;
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      state.complete?.();
      state.complete = null;
      state.completion = null;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    if (state.cancelling || this.shuttingDown) return;
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (!this.shuttingDown && !state.cancelling) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private hasBackgroundCapacity(): boolean {
    const backgroundCount = [...this.groups.values()].filter(
      (state) => state.active && state.isTaskContainer,
    ).length;
    return (
      this.activeCount < MAX_CONCURRENT_CONTAINERS &&
      backgroundCount < Math.max(1, MAX_CONCURRENT_CONTAINERS - 1)
    );
  }

  private drainGroup(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (
      (state.pendingMessages || state.pendingTasks.length) &&
      !this.waitingGroups.includes(groupJid)
    )
      this.waitingGroups.push(groupJid);
    this.drainWaiting();
  }

  private drainWaiting(): void {
    if (this.shuttingDown) return;
    // Search all lanes for foreground work before admitting any background job.
    while (this.activeCount < MAX_CONCURRENT_CONTAINERS) {
      const eligible = (jid: string) => {
        const state = this.getGroup(jid);
        return !state.active && !state.cancelling;
      };
      let index = this.waitingGroups.findIndex(
        (jid) => eligible(jid) && this.getGroup(jid).pendingMessages,
      );
      if (index < 0 && this.hasBackgroundCapacity()) {
        index = this.waitingGroups.findIndex(
          (jid) => eligible(jid) && this.getGroup(jid).pendingTasks.length > 0,
        );
      }
      if (index < 0) break;
      const [jid] = this.waitingGroups.splice(index, 1);
      const state = this.getGroup(jid);
      const run = state.pendingMessages
        ? this.runForGroup(jid, 'drain')
        : this.runTask(jid, state.pendingTasks.shift()!);
      void run.catch((err) =>
        logger.error({ groupJid: jid, err }, 'Queue drain failed'),
      );
    }
  }

  snapshot() {
    return [...this.groups.entries()].map(([groupJid, state]) => ({
      groupJid,
      active: state.active,
      idleWaiting: state.idleWaiting,
      isTaskContainer: state.isTaskContainer,
      runningTaskId: state.runningTaskId,
      pendingMessages: state.pendingMessages,
      pendingTasks: state.pendingTasks.map((task) => task.id),
      containerName: state.containerName,
      groupFolder: state.groupFolder,
      cancelling: state.cancelling,
      startedAt: state.startedAt,
      lastProgressAt: state.lastProgressAt,
    }));
  }

  private async stopProcess(state: GroupState): Promise<void> {
    const name = state.containerName;
    if (!name) return;
    // Runtime names are generated internally; validate before using the runtime helper.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))
      throw new Error('Invalid container name');
    try {
      await new Promise<void>((resolve, reject) => {
        exec(stopContainer(name), { timeout: 15_000 }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
    } catch {
      await new Promise<void>((resolve, reject) => {
        execFile(
          CONTAINER_RUNTIME_BIN,
          ['kill', name],
          { timeout: 10_000 },
          (err) => (err ? reject(err) : resolve()),
        );
      });
    }
  }

  async cancel(groupJid: string): Promise<void> {
    const state = this.getGroup(groupJid);
    state.cancelling = true;
    state.pendingMessages = false;
    state.pendingTasks = [];
    state.retryCount = 0;
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = null;
    this.waitingGroups = this.waitingGroups.filter((jid) => jid !== groupJid);
    try {
      await this.stopProcess(state);
      if (state.completion) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            state.completion,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      `Cancellation still waiting for ${groupJid} to exit`,
                    ),
                  ),
                30_000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
    } finally {
      // A failed stop must not reopen an occupied lane or allow retry/replay.
      if (!state.active) state.cancelling = false;
      this.drainWaiting();
    }
  }

  async shutdown(_gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;
    for (const state of this.groups.values()) {
      if (state.retryTimer) clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }

    // Count active containers but don't kill them — they'll finish on their own
    // via idle timeout or container timeout. The --rm flag cleans them up on exit.
    // This prevents WhatsApp reconnection restarts from killing working agents.
    const activeContainers: string[] = [];
    for (const [jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.containerName) {
        activeContainers.push(state.containerName);
      }
    }

    logger.info(
      { activeCount: this.activeCount, detachedContainers: activeContainers },
      'GroupQueue shutting down (containers detached, not killed)',
    );
  }
}

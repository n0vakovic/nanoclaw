import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentJob, JobDependencies, JobManager } from './job-manager.js';
import { RegisteredGroup } from './types.js';

const group = (folder: string, isMain = false): RegisteredGroup => ({
  name: folder,
  folder,
  isMain,
  trigger: '@Ras',
  added_at: '2026-09-08',
});
let directory: string;
let filename: string;
let manager: JobManager;
let dependencies: JobDependencies;
let callbacks: Map<string, () => Promise<void>>;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-jobs-'));
  filename = path.join(directory, 'jobs.db');
  callbacks = new Map();
  dependencies = {
    groups: () => ({
      'tg:1': group('main', true),
      'tg:-2': group('alpha'),
      'tg:-3': group('beta'),
    }),
    enqueue: vi.fn((key, _id, run) => {
      callbacks.set(key, run);
    }),
    cancel: vi.fn(async () => {}),
    steer: vi.fn(() => true),
    run: vi.fn(async () => 'Research result'),
    send: vi.fn(async () => {}),
    incident: vi.fn(() => 'incident-123'),
  };
  manager = new JobManager(filename, dependencies);
});
afterEach(() => {
  manager.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
const execute = (job: AgentJob) => callbacks.get(`job:${job.id}`)!();
const reopen = () => {
  manager.close();
  manager = new JobManager(filename, dependencies);
};

describe('durable background jobs', () => {
  it('deduplicates an origin request across restart and uses independent queue keys', () => {
    const job = manager.start('alpha', 'request-1', 'Research topic');
    expect(dependencies.enqueue).toHaveBeenCalledWith(
      `job:${job.id}`,
      job.id,
      expect.any(Function),
    );
    reopen();
    expect(manager.start('alpha', 'request-1', 'Retry same request').id).toBe(
      job.id,
    );
    expect(dependencies.enqueue).toHaveBeenCalledTimes(1);
    const another = manager.start('alpha', 'request-2', 'Other research');
    expect(another.id).not.toBe(job.id);
    expect(callbacks.has(`job:${another.id}`)).toBe(true);
  });
  it('isolates group access and deduplication while allowing main oversight', async () => {
    const alpha = manager.start('alpha', 'same-request', 'A');
    const beta = manager.start('beta', 'same-request', 'B');
    expect(manager.list('alpha').map((job) => job.id)).toEqual([alpha.id]);
    expect(manager.list('main')).toHaveLength(2);
    expect(manager.get('main', beta.id).id).toBe(beta.id);
    expect(() => manager.get('beta', alpha.id)).toThrow(/access denied/);
    await expect(manager.cancel('beta', alpha.id)).rejects.toThrow(
      /access denied/,
    );
    expect(() => manager.steer('beta', alpha.id, 'Change task')).toThrow(
      /access denied/,
    );
    expect(dependencies.cancel).not.toHaveBeenCalled();
  });
  it('cancels queued work before execution with evidence preserved', async () => {
    const job = manager.start('alpha', 'request', 'Research');
    await manager.cancel('alpha', job.id);
    await execute(job);
    expect(dependencies.incident).toHaveBeenCalledWith(
      'background_job_cancel',
      expect.objectContaining({ id: job.id, state: 'queued' }),
    );
    expect(dependencies.cancel).toHaveBeenCalledWith(`job:${job.id}`);
    expect(manager.get('alpha', job.id)).toMatchObject({
      state: 'cancelled',
      incident_id: 'incident-123',
    });
    expect(dependencies.run).not.toHaveBeenCalled();
    expect(dependencies.send).not.toHaveBeenCalled();
  });
  it('does not allow late progress or completion to resurrect cancelled running work', async () => {
    let finish!: (value: string) => void;
    let progress!: (phase: string) => void;
    dependencies.run = vi.fn((_job, _group, report) => {
      progress = report;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const job = manager.start('alpha', 'request', 'Research');
    const running = execute(job);
    progress('researching');
    expect(manager.get('alpha', job.id).phase).toBe('researching');
    await manager.cancel('alpha', job.id);
    progress('late-progress');
    finish('Late result');
    await running;
    expect(manager.get('alpha', job.id)).toMatchObject({
      state: 'cancelled',
      result: null,
      incident_id: 'incident-123',
    });
    expect(dependencies.send).not.toHaveBeenCalled();
  });
  it('leaves work untouched when diagnostic capture fails', async () => {
    const job = manager.start('alpha', 'request', 'Research');
    dependencies.incident = vi.fn(() => {
      throw new Error('Disk full');
    });
    await expect(manager.cancel('alpha', job.id)).rejects.toThrow('Disk full');
    expect(dependencies.cancel).not.toHaveBeenCalled();
    expect(manager.get('alpha', job.id).state).toBe('queued');
  });
  it('marks running work interrupted after restart, never replaying it', async () => {
    dependencies.run = vi.fn(() => new Promise<string>(() => {}));
    const running = manager.start('alpha', 'running', 'In progress');
    void execute(running);
    const queued = manager.start('alpha', 'queued', 'Not started');
    reopen();
    callbacks.clear();
    vi.mocked(dependencies.enqueue).mockClear();
    await manager.recover();
    expect(manager.get('alpha', running.id)).toMatchObject({
      state: 'interrupted',
      incident_id: 'incident-123',
      delivery: 'delivered',
    });
    expect(dependencies.incident).toHaveBeenCalledWith(
      'background_job_interrupted',
      expect.objectContaining({ id: running.id }),
    );
    expect([...callbacks.keys()]).toEqual([`job:${queued.id}`]);
    expect(dependencies.run).toHaveBeenCalledTimes(1);
  });
  it('does not retry an ambiguous completion notification on restart', async () => {
    dependencies.send = vi.fn(async () => {
      throw new Error('Transport timed out after send');
    });
    const job = manager.start('alpha', 'request', 'Research');
    await execute(job);
    expect(manager.get('alpha', job.id)).toMatchObject({
      state: 'completed',
      delivery: 'unknown',
      result: 'Research result',
    });
    reopen();
    await manager.recover();
    expect(dependencies.send).toHaveBeenCalledTimes(1);
  });
  it('converts a notification claimed before a crash to unknown without resending', async () => {
    const job = manager.start('alpha', 'request', 'Research');
    const database = new Database(filename);
    database
      .prepare(
        "UPDATE agent_jobs SET state='completed',delivery='sending' WHERE id=?",
      )
      .run(job.id);
    database.close();
    reopen();
    await manager.recover();
    expect(manager.get('alpha', job.id).delivery).toBe('unknown');
    expect(dependencies.send).not.toHaveBeenCalled();
  });
});

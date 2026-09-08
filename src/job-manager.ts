import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RegisteredGroup } from './types.js';

export type JobState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export interface AgentJob {
  id: string;
  request_id: string;
  group_folder: string;
  chat_jid: string;
  task: string;
  state: JobState;
  phase: string;
  result: string | null;
  incident_id: string | null;
  created_at: string;
  updated_at: string;
  delivery: 'pending' | 'sending' | 'delivered' | 'unknown';
}
export interface JobDependencies {
  groups(): Record<string, RegisteredGroup>;
  enqueue(key: string, id: string, run: () => Promise<void>): void;
  cancel(key: string): Promise<void>;
  steer(key: string, text: string): boolean;
  run(
    job: AgentJob,
    group: RegisteredGroup,
    progress: (phase: string) => void,
  ): Promise<string>;
  send(jid: string, text: string): Promise<void>;
  incident(reason: string, job: AgentJob): string;
}

/** Host-owned durable jobs. A restarted running job is never silently replayed. */
export class JobManager {
  private db: Database.Database;
  private cancelling = new Set<string>();
  constructor(
    filename: string,
    private deps: JobDependencies,
  ) {
    if (filename !== ':memory:')
      fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS agent_jobs (
      id TEXT PRIMARY KEY, request_id TEXT NOT NULL, group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL, task TEXT NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL,
      result TEXT, incident_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      delivery TEXT NOT NULL DEFAULT 'pending', UNIQUE(group_folder, request_id));`);
  }
  close(): void {
    this.db.close();
  }
  private raw(id: string): AgentJob | undefined {
    return this.db.prepare('SELECT * FROM agent_jobs WHERE id = ?').get(id) as
      | AgentJob
      | undefined;
  }
  private main(source: string): boolean {
    return Object.values(this.deps.groups()).some(
      (g) => g.folder === source && g.isMain,
    );
  }
  get(source: string, id: string): AgentJob {
    const job = this.raw(id);
    if (!job || (job.group_folder !== source && !this.main(source)))
      throw new Error('Job not found or access denied');
    return job;
  }
  list(source: string): AgentJob[] {
    return (
      this.main(source)
        ? this.db
            .prepare(
              'SELECT * FROM agent_jobs ORDER BY created_at DESC LIMIT 20',
            )
            .all()
        : this.db
            .prepare(
              'SELECT * FROM agent_jobs WHERE group_folder = ? ORDER BY created_at DESC LIMIT 20',
            )
            .all(source)
    ) as AgentJob[];
  }
  start(source: string, requestId: string, task: string): AgentJob {
    const entry = Object.entries(this.deps.groups()).find(
      ([, g]) => g.folder === source,
    );
    if (!entry) throw new Error('Origin group is not registered');
    if (!task.trim() || task.length > 32000)
      throw new Error('Task must contain 1–32000 characters');
    const old = this.db
      .prepare(
        'SELECT * FROM agent_jobs WHERE group_folder = ? AND request_id = ?',
      )
      .get(source, requestId) as AgentJob | undefined;
    if (old) return old;
    const { n } = this.db
      .prepare(
        "SELECT count(*) AS n FROM agent_jobs WHERE state IN ('queued','running')",
      )
      .get() as { n: number };
    if (n >= 20)
      throw new Error(
        'Background job queue is full; finish or cancel existing work first',
      );
    const id = `J-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO agent_jobs (id,request_id,group_folder,chat_jid,task,state,phase,created_at,updated_at) VALUES (?,?,?,?,?,'queued','queued',?,?)",
      )
      .run(id, requestId, source, entry[0], task, now, now);
    this.enqueue(this.raw(id)!);
    return this.raw(id)!;
  }
  private update(
    id: string,
    state: JobState,
    phase: string,
    result: string | null = null,
    incident: string | null = null,
  ): void {
    this.db
      .prepare(
        'UPDATE agent_jobs SET state=?,phase=?,result=?,incident_id=?,updated_at=? WHERE id=?',
      )
      .run(state, phase, result, incident, new Date().toISOString(), id);
  }
  private enqueue(job: AgentJob): void {
    this.deps.enqueue(`job:${job.id}`, job.id, async () => {
      if (this.raw(job.id)?.state !== 'queued') return;
      const group = this.deps.groups()[job.chat_jid];
      this.update(job.id, 'running', 'starting');
      const canUpdate = () =>
        !this.cancelling.has(job.id) && this.raw(job.id)?.state === 'running';
      try {
        if (!group || group.folder !== job.group_folder)
          throw new Error('Origin group no longer registered');
        const result = await this.deps.run(job, group, (phase) => {
          if (canUpdate()) this.update(job.id, 'running', phase);
        });
        if (canUpdate())
          this.update(job.id, 'completed', 'completed', result.slice(0, 64000));
      } catch {
        if (canUpdate()) {
          const incident = this.deps.incident(
            'background_job_failed',
            this.raw(job.id)!,
          );
          this.update(job.id, 'failed', 'failed', null, incident);
        }
      }
      if (['completed', 'failed'].includes(this.raw(job.id)?.state || ''))
        await this.deliver(job.id);
    });
  }
  private async deliver(id: string): Promise<void> {
    const job = this.raw(id)!;
    // Claim before the external send. Ambiguous delivery is visible, never blindly replayed.
    const claim = this.db
      .prepare(
        "UPDATE agent_jobs SET delivery='sending' WHERE id=? AND delivery='pending'",
      )
      .run(id);
    if (!claim.changes) return;
    try {
      await this.deps.send(
        job.chat_jid,
        `${id} · ${job.state}${job.incident_id ? ` · incident ${job.incident_id}` : ''}\n${job.result || 'Use /status ' + id + ' for details.'}`,
      );
      this.db
        .prepare("UPDATE agent_jobs SET delivery='delivered' WHERE id=?")
        .run(id);
    } catch {
      this.db
        .prepare("UPDATE agent_jobs SET delivery='unknown' WHERE id=?")
        .run(id);
    }
  }
  async cancel(source: string, id: string): Promise<string> {
    const job = this.get(source, id);
    if (!['queued', 'running'].includes(job.state))
      return `${id} is already ${job.state}.`;
    const incident = this.deps.incident('background_job_cancel', job);
    this.cancelling.add(id);
    try {
      await this.deps.cancel(`job:${id}`);
      this.update(id, 'cancelled', 'cancelled', null, incident);
    } catch (err) {
      // Keep it visibly running/cancelling if the container could not be stopped.
      this.update(id, 'running', 'cancellation_failed', null, incident);
      throw err;
    } finally {
      this.cancelling.delete(id);
    }
    return `${id} cancelled. Incident ${incident}. External effects already performed are preserved.`;
  }
  steer(source: string, id: string, instruction: string): string {
    const job = this.get(source, id);
    if (
      job.state !== 'running' ||
      !instruction.trim() ||
      instruction.length > 8000
    )
      throw new Error('Steering requires a running job and 1–8000 characters');
    if (!this.deps.steer(`job:${id}`, instruction))
      throw new Error('Job input is not available yet');
    return `${id}: instruction queued; it applies at the next model boundary.`;
  }
  async recover(): Promise<void> {
    this.db
      .prepare(
        "UPDATE agent_jobs SET delivery='unknown' WHERE delivery='sending'",
      )
      .run();
    for (const job of this.db
      .prepare("SELECT * FROM agent_jobs WHERE state='running'")
      .all() as AgentJob[]) {
      const incident = this.deps.incident('background_job_interrupted', job);
      this.update(job.id, 'interrupted', 'interrupted', null, incident);
    }
    for (const job of this.db
      .prepare("SELECT * FROM agent_jobs WHERE state='queued'")
      .all() as AgentJob[])
      this.enqueue(job);
    for (const job of this.db
      .prepare(
        "SELECT * FROM agent_jobs WHERE state NOT IN ('queued','running') AND delivery='pending'",
      )
      .all() as AgentJob[])
      await this.deliver(job.id);
  }
}

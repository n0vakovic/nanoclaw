import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildIdentity {
  sha: string;
  branch: string;
  builtAt: string;
  dirty: boolean | null;
}

export interface RecoveryQueueEntry {
  groupJid: string;
  active?: boolean;
  containerName?: string;
  runningTaskId?: string;
  cancelling?: boolean;
  errorCode?: string;
  pendingMessages?: number | boolean;
  pendingTasks?: number;
  startedAt?: string;
  lastProgressAt?: string;
}

/** Deliberately excludes message text, prompts, environment, and error messages. */
export interface RecoverySnapshot {
  groupJid?: string;
  sessionId?: string;
  messageId?: string;
  messageCursor?: string;
  phase?: string;
  pendingMessages?: number;
  activeContainers?: number;
  uptimeSeconds?: number;
  queue?: RecoveryQueueEntry[];
  errorCode?: string;
  exitCode?: number;
}

export function recoveryStateDir(): string {
  return (
    process.env.NANOCLAW_STATE_DIR ||
    path.join(os.homedir(), '.local/state/nanoclaw')
  );
}

function token(value: unknown, limit = 160): string | undefined {
  return typeof value === 'string' &&
    value.length <= limit &&
    /^[a-zA-Z0-9_@.:/+\-]*$/.test(value)
    ? value
    : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function sanitize(snapshot: RecoverySnapshot): RecoverySnapshot {
  return {
    groupJid: token(snapshot.groupJid),
    sessionId: token(snapshot.sessionId),
    messageId: token(snapshot.messageId),
    messageCursor: token(snapshot.messageCursor),
    phase: token(snapshot.phase, 64),
    pendingMessages: numeric(snapshot.pendingMessages),
    activeContainers: numeric(snapshot.activeContainers),
    uptimeSeconds: numeric(snapshot.uptimeSeconds),
    errorCode: token(snapshot.errorCode, 64),
    exitCode: numeric(snapshot.exitCode),
    queue: Array.isArray(snapshot.queue)
      ? snapshot.queue
          .slice(0, 100)
          .filter((entry) => entry !== null && typeof entry === 'object')
          .map((entry) => ({
            groupJid: token(entry.groupJid) || 'unknown',
            containerName: token(entry.containerName),
            runningTaskId: token(entry.runningTaskId),
            cancelling:
              typeof entry.cancelling === 'boolean'
                ? entry.cancelling
                : undefined,
            errorCode: token(entry.errorCode, 64),
            active:
              typeof entry.active === 'boolean' ? entry.active : undefined,
            pendingMessages:
              typeof entry.pendingMessages === 'boolean'
                ? entry.pendingMessages
                : numeric(entry.pendingMessages),
            pendingTasks: numeric(entry.pendingTasks),
            startedAt: token(entry.startedAt),
            lastProgressAt: token(entry.lastProgressAt),
          }))
      : undefined,
  };
}

function atomicWrite(filename: string, value: unknown): void {
  const dir = path.dirname(filename);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function readBuildIdentity(): BuildIdentity {
  try {
    const filename = fileURLToPath(
      new URL('./build-info.json', import.meta.url),
    );
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    return {
      sha: token(value.sha) || 'unknown',
      branch: token(value.branch) || 'unknown',
      builtAt: token(value.builtAt) || 'unknown',
      dirty: typeof value.dirty === 'boolean' ? value.dirty : null,
    };
  } catch {
    return {
      sha: 'unknown',
      branch: 'unknown',
      builtAt: 'unknown',
      dirty: null,
    };
  }
}

/** Call before destructive recovery. A write failure throws: never claim evidence exists when it does not. */
export function captureIncident(
  reason: string,
  snapshot: RecoverySnapshot,
): string {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
  atomicWrite(path.join(recoveryStateDir(), 'incidents', `${id}.json`), {
    schemaVersion: 1,
    id,
    reason: token(reason, 80) || 'unspecified',
    capturedAt: new Date().toISOString(),
    pid: process.pid,
    build: readBuildIdentity(),
    snapshot: sanitize(snapshot),
  });
  return id;
}

/** Small host-only liveness record, replaced atomically by the worker. */
export function writeHeartbeat(snapshot: RecoverySnapshot): void {
  atomicWrite(path.join(recoveryStateDir(), 'heartbeat.json'), {
    schemaVersion: 1,
    at: new Date().toISOString(),
    pid: process.pid,
    build: readBuildIdentity(),
    snapshot: sanitize(snapshot),
  });
}

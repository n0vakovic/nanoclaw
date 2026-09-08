import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureIncident,
  readBuildIdentity,
  RecoverySnapshot,
  writeHeartbeat,
} from './recovery.js';

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-recovery-'));
  vi.stubEnv('NANOCLAW_STATE_DIR', directory);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('recovery evidence', () => {
  it('records operational evidence but drops unknown properties and raw text', () => {
    const id = captureIncident('clear-session', {
      groupJid: 'telegram:123',
      sessionId: 'session-123',
      phase: 'initializing',
      messageCursor: '2026-09-08T12:00:00.000Z',
      exitCode: 137,
      errorCode: 'Error with token=secret',
      prompt: 'private conversation',
      env: { TOKEN: 'private-token' },
      queue: [
        {
          groupJid: 'telegram:123',
          active: true,
          prompt: 'private nested text',
        },
      ],
    } as unknown as RecoverySnapshot);
    const filename = path.join(directory, 'incidents', `${id}.json`);
    const contents = fs.readFileSync(filename, 'utf8');
    const incident = JSON.parse(contents);
    expect(incident.snapshot.sessionId).toBe('session-123');
    expect(incident.snapshot.exitCode).toBe(137);
    expect(contents).not.toMatch(/private|secret|prompt|TOKEN/);
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(filename))).toEqual([`${id}.json`]);
  });
  it('bounds queue evidence and replaces heartbeat atomically', () => {
    writeHeartbeat({
      phase: 'ready',
      queue: Array.from({ length: 500 }, () => ({ groupJid: 'g' })),
    });
    const filename = path.join(directory, 'heartbeat.json');
    expect(
      JSON.parse(fs.readFileSync(filename, 'utf8')).snapshot.queue,
    ).toHaveLength(100);
    writeHeartbeat({ phase: 'stopping' });
    expect(JSON.parse(fs.readFileSync(filename, 'utf8')).snapshot.phase).toBe(
      'stopping',
    );
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(['heartbeat.json']);
  });
  it('does not silently continue if evidence cannot be saved', () => {
    fs.writeFileSync(path.join(directory, 'incidents'), 'not a directory');
    expect(() => captureIncident('restart', {})).toThrow();
  });
  it('reports unknown identity honestly in an unstamped source execution', () => {
    expect(readBuildIdentity()).toEqual({
      sha: 'unknown',
      branch: 'unknown',
      builtAt: 'unknown',
      dirty: null,
    });
  });
});

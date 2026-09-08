import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let directory: string;
let bin: string;
let state: string;
function run() {
  execFileSync(
    process.execPath,
    [path.join(directory, 'scripts/recovery-supervisor.mjs')],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NANOCLAW_STATE_DIR: state,
      },
      stdio: 'pipe',
    },
  );
}
function worker(activeState: string, subState: string) {
  fs.writeFileSync(
    path.join(bin, 'properties'),
    `ActiveState=${activeState}\nSubState=${subState}\nResult=success\nExecMainStatus=0\nActiveEnterTimestampMonotonic=1\nMainPID=42\n`,
  );
}
function heartbeat(age: number) {
  fs.writeFileSync(
    path.join(state, 'heartbeat.json'),
    JSON.stringify({
      at: new Date(Date.now() - age).toISOString(),
      pid: 42,
      snapshot: { phase: 'waiting' },
    }),
  );
}
function incidents(): string[] {
  const file = path.join(state, 'incidents.log');
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n')
    : [];
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-supervisor-'));
  bin = path.join(directory, 'bin');
  state = path.join(directory, 'state');
  for (const dir of [
    bin,
    state,
    path.join(directory, 'scripts'),
    path.join(directory, 'dist'),
  ])
    fs.mkdirSync(dir);
  fs.copyFileSync(
    'scripts/recovery-supervisor.mjs',
    path.join(directory, 'scripts/recovery-supervisor.mjs'),
  );
  fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(
    path.join(directory, 'dist/recovery.js'),
    `
    import fs from 'node:fs';
    import path from 'node:path';
    export function recoveryStateDir() { return process.env.NANOCLAW_STATE_DIR; }
    export function captureIncident(reason) {
      fs.appendFileSync(path.join(recoveryStateDir(), 'incidents.log'), reason + '\\n');
      return 'test-incident';
    }
  `,
  );
  fs.writeFileSync(
    path.join(bin, 'systemctl'),
    `#!/bin/sh
case "$2" in
  show) cat "$(dirname "$0")/properties" ;;
  restart) echo restart >> "$(dirname "$0")/restarts" ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe('independent recovery supervisor', () => {
  it('leaves a healthy worker and intentionally stopped worker alone', () => {
    worker('active', 'running');
    heartbeat(0);
    run();
    worker('inactive', 'dead');
    heartbeat(600_000);
    run();
    expect(incidents()).toEqual([]);
    expect(fs.existsSync(path.join(bin, 'restarts'))).toBe(false);
  });
  it('captures evidence before a stale worker restart and applies backoff', () => {
    worker('active', 'running');
    heartbeat(600_000);
    run();
    run();
    expect(incidents()).toEqual(['supervisor-stale-heartbeat']);
    expect(fs.readFileSync(path.join(bin, 'restarts'), 'utf8')).toBe(
      'restart\n',
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(state, 'supervisor.json'), 'utf8'))
        .incidentId,
    ).toBe('test-incident');
  });
  it('records failed workers without adding another restart loop', () => {
    worker('failed', 'failed');
    run();
    run();
    expect(incidents()).toEqual(['supervisor-worker-failed']);
    expect(fs.existsSync(path.join(bin, 'restarts'))).toBe(false);
  });
  it('enforces the hourly restart budget', () => {
    worker('active', 'running');
    heartbeat(600_000);
    fs.writeFileSync(
      path.join(state, 'supervisor.json'),
      JSON.stringify({
        restarts: [
          Date.now() - 600_000,
          Date.now() - 500_000,
          Date.now() - 400_000,
        ],
      }),
    );
    run();
    run();
    expect(incidents()).toEqual(['supervisor-restart-budget-exhausted']);
    expect(fs.existsSync(path.join(bin, 'restarts'))).toBe(false);
  });
});

#!/usr/bin/env node
// Run once per minute from an independent systemd user timer. No bot token or
// Telegram polling: this path remains usable when the worker event loop hangs.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { captureIncident, recoveryStateDir } from '../dist/recovery.js';

const stateDir = recoveryStateDir();
const stateFile = path.join(stateDir, 'supervisor.json');
const lockDir = path.join(stateDir, 'supervisor.lock');
const staleMs = 120_000;
const restartBackoffMs = 300_000;
const restartWindowMs = 3_600_000;
const maxRestarts = 3;
const now = Date.now();
const systemctl = (...args) =>
  execFileSync('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const readJSON = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
const writeState = (state) => {
  const temporary = `${stateFile}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(temporary, stateFile);
};

fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
try {
  fs.mkdirSync(lockDir, { mode: 0o700 });
} catch (error) {
  // systemd already serializes the timer; also protect against manual overlap.
  if (error.code !== 'EEXIST') throw error;
  // A SIGKILL or timer timeout may leave a lock behind. Each invocation has
  // at most two 15-second systemctl calls, so two minutes is safely stale.
  if (now - fs.statSync(lockDir).mtimeMs <= staleMs) process.exit(0);
  fs.rmdirSync(lockDir);
  try {
    fs.mkdirSync(lockDir, { mode: 0o700 });
  } catch (retryError) {
    if (retryError.code === 'EEXIST') process.exit(0);
    throw retryError;
  }
}
try {
  const properties = Object.fromEntries(
    systemctl(
      'show',
      'nanoclaw.service',
      '--property=ActiveState,SubState,Result,ExecMainStatus,ActiveEnterTimestampMonotonic,MainPID',
    )
      .split('\n')
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  const heartbeat = readJSON(path.join(stateDir, 'heartbeat.json'));
  const previous = readJSON(stateFile);
  const restarts = (
    Array.isArray(previous.restarts) ? previous.restarts : []
  ).filter((value) => Number.isFinite(value) && value > now - restartWindowMs);
  const workerActive = properties.ActiveState === 'active';
  const heartbeatAt = Date.parse(heartbeat.at);
  // Monotonic unit start time avoids confusing a previous worker's heartbeat
  // with the current process, and allows startup a full grace period.
  const machineUptimeMs =
    Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000;
  const activeAgeMs =
    machineUptimeMs - Number(properties.ActiveEnterTimestampMonotonic) / 1000;
  const heartbeatIsCurrent = heartbeat.pid === Number(properties.MainPID);
  const stale =
    !heartbeatIsCurrent ||
    !Number.isFinite(heartbeatAt) ||
    now - heartbeatAt > staleMs;

  if (workerActive && (!stale || activeAgeMs < staleMs)) {
    writeState({ restarts, failure: null });
  } else if (workerActive && stale) {
    const backoffElapsed =
      !restarts.length || now - restarts.at(-1) >= restartBackoffMs;
    if (restarts.length < maxRestarts && backoffElapsed) {
      const id = captureIncident('supervisor-stale-heartbeat', {
        ...(heartbeatIsCurrent ? heartbeat.snapshot : {}),
        phase: 'heartbeat-stale',
        errorCode: 'WORKER_HEARTBEAT_TIMEOUT',
      });
      // Record the attempt before restart, including failed restart attempts.
      writeState({
        restarts: [...restarts, now],
        failure: 'heartbeat-stale',
        incidentId: id,
      });
      console.log(
        `Incident ${id}: stale worker heartbeat; restarting nanoclaw.service`,
      );
      systemctl('restart', 'nanoclaw.service');
    } else if (
      previous.failure !== 'restart-budget-exhausted' &&
      restarts.length >= maxRestarts
    ) {
      const id = captureIncident('supervisor-restart-budget-exhausted', {
        phase: 'heartbeat-stale',
        errorCode: 'RESTART_BUDGET_EXHAUSTED',
      });
      writeState({
        restarts,
        failure: 'restart-budget-exhausted',
        incidentId: id,
      });
      console.error(
        `Incident ${id}: restart budget exhausted; manual diagnosis required`,
      );
    }
  } else if (
    properties.ActiveState === 'failed' ||
    properties.SubState === 'auto-restart'
  ) {
    const failure = `${properties.ActiveState}:${properties.SubState}:${properties.Result}:${properties.ExecMainStatus}`;
    if (previous.failure !== failure) {
      const id = captureIncident('supervisor-worker-failed', {
        phase: properties.SubState,
        errorCode: properties.Result,
        exitCode: Number(properties.ExecMainStatus),
      });
      writeState({ restarts, failure, incidentId: id });
      console.error(
        `Incident ${id}: worker failed; systemd owns crash recovery`,
      );
    }
  }
} finally {
  fs.rmdirSync(lockDir);
}

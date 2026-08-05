import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { Agent } from 'undici';

const execFileAsync = promisify(execFile);
const SOCKET_SNAPSHOT_TIMEOUT_MS = 2_000;
const SOCKET_SNAPSHOT_MAX_BYTES = 256 * 1024;
const SOCKET_RECORD_LIMIT = 12;
const SOCKET_RECORD_MAX_CHARS = 4_000;

export type TcpSocketSnapshot = {
  capturedAt: string;
  command: 'ss -tinp';
  processId: number;
  sockets: string[];
  unavailable?: Record<string, unknown>;
};

export type DispatcherLifecycleTrace = {
  strategy: 'disposable_per_attempt';
  createdMs: number;
  connectEvents: Array<{ elapsedMs: number; origin: string }>;
  disconnectEvents: Array<{
    elapsedMs: number;
    origin: string;
    duringDestroy: boolean;
    error: Record<string, unknown>;
  }>;
  connectionErrors: Array<{
    elapsedMs: number;
    origin: string;
    error: Record<string, unknown>;
  }>;
  destroyStartedMs?: number;
  destroyCompletedMs?: number;
  destroyError?: Record<string, unknown>;
  failureSocketSnapshot?: TcpSocketSnapshot;
};

function describeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: String(error) };
  const extended = error as Error & { code?: string | number };
  return {
    name: error.name,
    message: error.message,
    ...(extended.code !== undefined ? { code: extended.code } : {}),
  };
}

function processSocketRecords(stdout: string): string[] {
  const records: string[] = [];
  let current = '';
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    if (/^State\s/.test(line)) continue;
    if (/^\S/.test(line)) {
      if (current) records.push(current);
      current = line;
    } else if (current) {
      current += `\n${line}`;
    }
  }
  if (current) records.push(current);

  const pidNeedle = `pid=${process.pid},`;
  return records
    .filter((record) => record.includes(pidNeedle))
    .slice(0, SOCKET_RECORD_LIMIT)
    .map((record) => record.slice(0, SOCKET_RECORD_MAX_CHARS));
}

/**
 * Capture bounded, payload-free TCP state for this NanoClaw process. Linux
 * `ss -tinp` exposes send queues, retransmits, MSS, cwnd, and RTO without
 * recording request bodies, credentials, or audio content.
 */
export async function captureTcpSocketSnapshot(): Promise<TcpSocketSnapshot> {
  const base: Omit<TcpSocketSnapshot, 'sockets'> = {
    capturedAt: new Date().toISOString(),
    command: 'ss -tinp',
    processId: process.pid,
  };
  try {
    const { stdout } = await execFileAsync('ss', ['-tinp'], {
      timeout: SOCKET_SNAPSHOT_TIMEOUT_MS,
      maxBuffer: SOCKET_SNAPSHOT_MAX_BYTES,
    });
    return { ...base, sockets: processSocketRecords(stdout) };
  } catch (error) {
    return { ...base, sockets: [], unavailable: describeError(error) };
  }
}

/**
 * One dispatcher per provider attempt prevents a stale pooled TCP connection
 * from being reused by later OpenAI or ElevenLabs requests.
 */
export function createDisposableDispatcher(startedAtMs: number): {
  dispatcher: Agent;
  trace: DispatcherLifecycleTrace;
  captureFailureSnapshot: () => Promise<void>;
  destroy: () => Promise<void>;
} {
  const dispatcher = new Agent({ connections: 1, pipelining: 1 });
  const trace: DispatcherLifecycleTrace = {
    strategy: 'disposable_per_attempt',
    createdMs: Date.now() - startedAtMs,
    connectEvents: [],
    disconnectEvents: [],
    connectionErrors: [],
  };
  const relativeTime = () => Date.now() - startedAtMs;

  dispatcher.on('connect', (origin) => {
    trace.connectEvents.push({
      elapsedMs: relativeTime(),
      origin: origin.toString(),
    });
  });
  dispatcher.on('disconnect', (origin, _targets, error) => {
    trace.disconnectEvents.push({
      elapsedMs: relativeTime(),
      origin: origin.toString(),
      duringDestroy: trace.destroyStartedMs !== undefined,
      error: describeError(error),
    });
  });
  dispatcher.on('connectionError', (origin, _targets, error) => {
    trace.connectionErrors.push({
      elapsedMs: relativeTime(),
      origin: origin.toString(),
      error: describeError(error),
    });
  });

  return {
    dispatcher,
    trace,
    captureFailureSnapshot: async () => {
      trace.failureSocketSnapshot = await captureTcpSocketSnapshot();
    },
    destroy: async () => {
      if (trace.destroyStartedMs !== undefined) return;
      trace.destroyStartedMs = relativeTime();
      try {
        await dispatcher.destroy();
        trace.destroyCompletedMs = relativeTime();
      } catch (error) {
        trace.destroyError = describeError(error);
      }
    },
  };
}

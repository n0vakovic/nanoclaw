/**
 * Bounded-time primitives for the message pipeline.
 *
 * The Telegram bot processes updates sequentially (grammy `bot.start()`), and
 * the IPC watcher processes outbound sends sequentially. Any unbounded `await`
 * in either loop freezes everything behind it. These helpers guarantee every
 * external call resolves or rejects within a known bound so a single stalled
 * network connection can never wedge the pipeline.
 */

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`Timed out after ${ms}ms: ${label}`);
    this.name = 'TimeoutError';
  }
}

/**
 * Race a promise against a timeout. Rejects with TimeoutError if `promise`
 * does not settle within `ms`. The timer is always cleared so a fast result
 * never leaves a dangling handle.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() =>
    clearTimeout(timer),
  ) as Promise<T>;
}

/**
 * fetch() with a hard timeout. Node's global fetch has no default timeout and
 * a stalled connection never rejects, so a bare `await fetch(url)` can hang
 * forever. AbortSignal.timeout aborts the request (rejecting the await) after
 * `ms`, letting callers fall back gracefully.
 */
export function fetchWithTimeout(
  url: string,
  ms: number,
  init?: RequestInit & { dispatcher?: Dispatcher },
): Promise<Response> {
  const requestInit = { ...init, signal: AbortSignal.timeout(ms) };
  if (init?.dispatcher) {
    // Node's bundled fetch and an npm-installed Dispatcher are not guaranteed
    // to share the same internal handler ABI. Keep fetch and Dispatcher from
    // the same Undici package whenever a custom Dispatcher is supplied.
    return undiciFetch(
      url,
      requestInit as UndiciRequestInit,
    ) as unknown as Promise<Response>;
  }
  return fetch(url, requestInit);
}
import {
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
} from 'undici';

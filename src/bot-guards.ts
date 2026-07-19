/**
 * Structural guards that keep the Telegram bot's two sequential loops from
 * being wedged by a single stalled call. See docs/concurrency-model.md.
 *
 *  - Inbound: grammy `bot.start()` processes updates one at a time. The
 *    handler-timeout middleware guarantees no update can block the poll loop
 *    longer than its budget — after that the handler is abandoned and the
 *    poller moves on.
 *  - Outbound: every `bot.api.*` call goes through the timeout transformer,
 *    which attaches an AbortSignal so a stalled send can never freeze the IPC
 *    watcher or the container output chain.
 */

import { withTimeout, TimeoutError } from './timeout.js';
import { logger } from './logger.js';

export type NextFn = () => Promise<void>;
export type UpdateMiddleware = (ctx: unknown, next: NextFn) => Promise<void>;

/**
 * Wrap each update handler so the sequential poll loop can never be blocked
 * indefinitely. On timeout the handler is abandoned (its pending promise is
 * left to settle or leak on its own) and the loop continues; on any other
 * error the middleware rethrows so grammy's `bot.catch` still handles it.
 */
export function createHandlerTimeoutMiddleware(
  ms: number,
  onTimeout: (err: TimeoutError) => void = (err) =>
    logger.error(
      { err: err.message },
      'Telegram update handler timed out; poller continues',
    ),
): UpdateMiddleware {
  return async (_ctx, next) => {
    try {
      await withTimeout(next(), ms, 'telegram-update-handler');
    } catch (err) {
      if (err instanceof TimeoutError) {
        onTimeout(err);
        return;
      }
      throw err;
    }
  };
}

/**
 * grammy API transformer signature (method, payload, signal) → result.
 */
export type ApiCall = (
  method: string,
  payload: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * Attach a hard timeout to every outbound Telegram API call. If the caller
 * already supplied a signal we leave it alone; otherwise we inject
 * AbortSignal.timeout(ms) so a stalled send rejects instead of hanging.
 */
export function createApiTimeoutTransformer(ms: number) {
  return (
    prev: ApiCall,
    method: string,
    payload: unknown,
    signal?: AbortSignal,
  ) => prev(method, payload, signal ?? AbortSignal.timeout(ms));
}

# Concurrency model: the message pipeline

This document explains how inbound and outbound messages flow through the host
process, why a single stalled network call used to freeze the whole bot, and the
invariants that now prevent it. Read this before touching the Telegram channel,
the IPC watcher, or the message loop.

## The two sequential loops

The host process has two loops that each process work **one item at a time**.
Anything that blocks the current item blocks everything behind it.

1. **grammy update polling** (`src/channels/telegram.ts`, `bot.start()`).
   grammy's built-in long polling handles updates strictly sequentially: it does
   not begin the next update until the current update's handler resolves. There
   is no per-update concurrency (that would require `@grammyjs/runner`).

2. **The IPC watcher** (`src/ipc.ts`, `processIpcFiles`). It scans each group's
   IPC directory and `await`s each outbound send / host action before moving on,
   re-arming itself only after the scan completes.

Because both loops are sequential, the governing rule is:

> **No handler and no send may take unbounded time. Every external call must be
> bounded, or the loop it runs in can wedge indefinitely.**

## The failure mode this replaced

A voice/photo handler downloaded the media with a bare `await fetch(url)`. Node's
global `fetch` has no default timeout, and a stalled TCP connection never
rejects, so the handler parked forever. Because update polling is sequential,
that one parked handler froze the entire bot: no crash, systemd saw a healthy
process, and every later message queued silently until a manual restart. The 👀
reaction still appeared because it is fire-and-forget (`void setReaction`) and
runs before the download.

## The guards (defense in depth)

Budgets live in `src/config.ts` (all overridable via env). Ordering is
deliberate: a media/transcription call must time out **before** the inbound
handler backstop, so a stalled request degrades to fallback text and the message
is still stored, rather than the whole handler being abandoned.

| Guard                                                       | Where                                                                | Budget                                                                   | Protects                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Per-fetch timeout (`fetchWithTimeout`)                      | media downloads in `telegram.ts`; every `fetch` in `host-actions.ts` | `TELEGRAM_MEDIA_TIMEOUT_MS` = 15s / `HOST_ACTION_FETCH_TIMEOUT_MS` = 30s | graceful degradation — a stalled download rejects into its catch and the message stores with fallback text                            |
| Automatic word-timestamp attempt                            | `transcription.ts` (`whisper-1`, verbose JSON)                       | `TRANSCRIPTION_TIMEOUT_MS` = 30s                                         | preserves pause markers when the word-timestamp path is healthy                                                                       |
| Automatic plain-text fallback                               | `transcription.ts` (`gpt-4o-mini-transcribe`, JSON)                  | `TRANSCRIPTION_FALLBACK_TIMEOUT_MS` = 30s                                | uses a different model/request shape when word timestamps stall; both attempts fit inside the handler budget                          |
| Retained-audio retry                                        | `host-actions.ts` and automatic retry in `telegram.ts`               | `RETAINED_TRANSCRIPTION_TIMEOUT_MS` = 120s                               | gives the simpler plain-transcription request room to recover without blocking Telegram's inbound handler                             |
| Durable retained-audio backoff                              | `telegram.ts`                                                        | `RETAINED_VOICE_RETRY_DELAYS_MS` = 30s, 2m, 10m, 30m (then 30m)          | retries indefinitely, resumes from metadata after restart, and injects a recovered transcript back into the original conversation     |
| Inbound handler backstop (`createHandlerTimeoutMiddleware`) | first `bot.use()` in `telegram.ts`                                   | `TELEGRAM_HANDLER_TIMEOUT_MS` = 90s                                      | grammy's poll loop — no single update can block it longer than the budget; on timeout the handler is abandoned and the loop continues |
| Outbound API backstop (`createApiTimeoutTransformer`)       | `bot.api.config.use()` in `telegram.ts`                              | `TELEGRAM_API_TIMEOUT_MS` = 30s                                          | every `bot.api.*` send — a stalled send can't freeze the IPC watcher or the container output chain                                    |

The primitives (`withTimeout`, `fetchWithTimeout`) live in `src/timeout.ts`; the
grammy guards in `src/bot-guards.ts`. Both are unit-tested in isolation, and
`telegram.test.ts` asserts they are installed on `connect()`.

Every transcription attempt logs an audio SHA-256, byte count, reported audio
duration, model/request mode, timeout, elapsed time, OpenAI request ID when one
exists, and undici transport phases (`request:create`, `bodySent`, response
headers, transport error). Direct request phases take precedence in failure
classification: a request that was created but never emitted `bodySent` is
reported as `transcription_upload_stalled_before_body_sent`, even if a later
credential-free connectivity probe also times out. This prevents a secondary
probe from becoming the false claim that OpenAI was down. The same structured
diagnostic is stored in the retained voice metadata JSON, so evidence survives
log rotation and remains coupled to the exact audio by SHA-256.

Failed Telegram transcriptions keep the audio plus retry state in the group IPC
media directory. Automatic retries use the plain transcription model, persist a
successful transcript under the group's `recovered-voice/` directory, and store
it as a new inbound recovery message so the agent receives the content without
the user resending or reconstructing it. Startup scans persisted retry metadata
and resumes any interrupted backoff. Explicit agent retries mark the metadata as
`manual_retry_in_progress`, preventing overlap with the automatic worker.

Telegram's `.oga` filename suffix is normalized to `.ogg` only for the OpenAI
multipart upload. The retained filename and bytes are unchanged. OpenAI rejects
the `.oga` alias during request validation even when the payload is valid Ogg
audio.

The two backstops (inbound middleware + outbound transformer) are the structural
guarantee: even a brand-new handler or a future `bot.api` call that forgets its
own timeout still cannot wedge either loop. The per-call timeouts are the
graceful-degradation layer on top.

## Message durability across restarts

Two cursors, both persisted in `router_state`:

- **`last_agent_timestamp`** — the _handoff_ cursor. Advances the moment a batch
  is handed to a container (including messages piped into an already-running
  container). Used by the message loop to avoid re-piping the same messages.
- **`last_confirmed_timestamp`** — the _processed_ cursor. Advances only when a
  container query actually completes (the agent emits a `success` result).

Crash recovery (`recoverPendingMessages`) keys off the **confirmed** cursor. This
closes a real bug: a message piped into a container that then crashed had already
advanced the handoff cursor, so it sat before the cursor and was never
re-delivered — the agent lost it and could wrongly conclude it had hallucinated.
Keying recovery off the confirmed cursor re-delivers anything piped but not
provably processed. Duplicate re-delivery (processed, then crashed right at the
success boundary) is acceptable — the agent simply re-reads a message — whereas
silent loss is not.

Migration: when `last_confirmed_timestamp` is absent it defaults to the current
handoff cursor, so an upgrade does not reprocess the backlog.

## Known residual limitations

- **Result-to-input correlation is coarse.** The confirmed cursor advances to the
  _latest handed-off_ message on any query completion, not to the specific
  message that result answered. In the rare window where message B is piped after
  a query starts but the crash lands between B's handoff and its own completion,
  B could be considered confirmed by an earlier result. Fixing this precisely
  needs per-message acks from the container, which the protocol does not yet
  carry. The freeze fix removes the crash-loop that made this fire in practice.
- **Abandoned handlers leak their pending promise.** When the inbound backstop
  times out a handler, the underlying request may still be pending; it is left to
  settle or be GC'd. The per-fetch timeout bounds the common case (the media
  download) so this is rare.

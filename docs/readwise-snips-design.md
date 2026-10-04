# Readwise / Snipd event integration

Status: proposed design, 2026-10-04. No receiver, subscription, deployment, or bot behavior has been changed.

## Intended behavior

When a Snipd highlight reaches Readwise, NanoClaw records it and can notify the main chat or process an episode in an independent agent session. The receiver is a shared host capability; the destination and processing policy are configuration. These are complementary choices, not competing architectures.

Suggested first release: ingest all Snipd episodes, accumulate their highlights, and send a compact episode notification to the registered main group. Optional synthesis can follow once the basic delivery works. Do not invoke an agent for every snip.

Example: “10 new snips from The Art of Accomplishment — A New Definition of People Pleasing” with the Readwise episode link. Preserve summaries, transcript excerpts, timestamps, and individual Snipd URLs for later retrieval.

## Evidence and existing integration points

- Readwise documents `readwise.highlight.created`, JSON POST payloads containing a highlight ID, book ID, text and a shared secret: https://docs.readwise.io/readwise/docs/webhooks
- The documented highlight payload does not contain the book's title, author, or source. Resolve those through the Readwise API; do not assume a Snipd-only subscription exists.
- The live API check on October 4 returned book `64051371`, source `snipd`, category `podcasts`, and ten highlights from the example episode above. This verifies the current Snipd-to-Readwise path, not webhook delivery.
- `src/index.ts:setupBackgroundJobs` wires `JobManager` to the queue, isolated container executions, and strict channel delivery. `JobManager.start` deduplicates requests by group and request ID. Reuse this for optional synthesis.
- `src/intergroup-inbox.ts` assumes a registered source group distinct from main. An external provider is not a registered group: do not invent a source group just to use this API.
- `src/task-scheduler.ts` executes agent tasks. A lightweight reconciliation timer should run on the host instead of starting an LLM just to poll an API.
- `docs/concurrency-model.md` requires bounded external calls. Ingestion and enrichment must not block chat handlers or the IPC loop.

## Data flow

1. A public HTTPS ingress forwards only `POST /webhooks/readwise` to a loopback-bound receiver in the NanoClaw host process. Choose a reverse proxy or tunnel appropriate to the actual deployment before implementation; no public hostname is assumed here.
2. Validate a bounded JSON body, compare the body `secret` to the configured webhook secret in constant time, and validate the event type and numeric IDs. This is the documented shared-secret mechanism, not an invented HMAC header protocol. Remove the secret before persistence or logging.
3. Transactionally insert a durable event with a unique `(provider, event_type, highlight_id)` key. Reply with success after commit, including on duplicates. Return an error if storage fails. Never wait for Readwise, Telegram, or a container before acknowledging.
4. A bounded background worker fetches the book metadata and current highlights through the Readwise API. Cache book metadata and retain only source `snipd`. Ignore deleted highlights. Retry network and rate-limit failures with backoff and `Retry-After` support.
5. Upsert normalized highlights and add unseen ones to a persisted episode batch. Suggested default: flush after ten minutes without a new highlight, with a maximum thirty-minute delay from the first pending highlight. This is a heuristic, not detection that listening has ended. Later snips create another batch.
6. Resolve the configured group from registered groups (`isMain` by default), create a durable delivery record, then send through the existing strict outbound routing. A notification is not a synthetic user message and must not advance the foreground conversation cursor or inject text into an active agent.
7. If synthesis is enabled, start a detached `JobManager` request keyed by the persisted batch ID. Run in the configured processing group; keep delivery in that group for v1, since the current job API couples execution group and destination. A separate processing/delivery split would need an explicit extension.

## Persistence and recovery

Proposed host-owned SQLite database, `store/integration-events.db`, with:

| Table | Main fields and constraints |
| --- | --- |
| events | provider, type, highlight ID (unique together), sanitized payload, state, attempts, next attempt, last error |
| highlights | provider + highlight ID (unique), book ID, source metadata, summary/transcript text, source URLs, timestamps |
| batches / batch_members | batch ID, book ID, destination, first/last receipt, due time, state; unique highlight membership |
| deliveries | batch ID + destination + mode (unique), pending/sending/delivered/unknown, attempt metadata |
| checkpoints | provider, last fully processed reconciliation timestamp |

Recover pending enrichment and open batches on startup. Reconciliation uses the export API's `updatedAfter` plus every `nextPageCursor`; overlap the last checkpoint and deduplicate by highlight ID. Advance the checkpoint only after all pages are safely processed. Suggested interval: fifteen minutes, and once on startup. Default initial checkpoint is activation time so old highlights are not unexpectedly announced; backfill is explicit.

Webhook retry guarantees are not established by the cited custom-webhook documentation, so recovery must not depend on retries. Updates discovered by reconciliation refresh stored text without producing another “new snip” notification.

Channel sends cannot be assumed exactly once. If a send may have succeeded but acknowledgment was lost, retain `unknown` for inspection rather than blindly resending. Reuse the existing JobManager delivery semantics for synthesis, including its policy that interrupted running jobs are not silently replayed.

## Configuration and access

Host-only secrets: `READWISE_API_TOKEN` and a separate `READWISE_WEBHOOK_SECRET`. The API credential already exists in Doppler `personal/dev`; deployment must explicitly provide the two required secrets to the service. Do not copy all Doppler secrets into agent containers or commit them to this repository.

Non-secret configuration: enabled flag, loopback address/port, allowed source (`snipd`), destination group, notification/synthesis mode, quiet window, maximum batch delay, reconciliation interval, and optional podcast filters. Resolve the destination from trusted configuration, never from webhook content. If the group is missing, retain pending work and report a local health error.

Podcast text is untrusted reference material. An optional synthesis prompt must delimit it as data and must not treat embedded requests as tool instructions. Prefer a restricted processing group for autonomous analysis: an isolated session in main still inherits main privileges.

Main-only administration should expose status, pause/resume, pending batches, failed enrichment and unknown deliveries. Status must never show credentials. Disabling ingestion also disables reconciliation; already recorded data remains inspectable.

## Proposed file changes

| File | Responsibility |
| --- | --- |
| `src/integrations/readwise.ts` | API client, metadata cache, normalization, reconciliation |
| `src/integrations/webhook-server.ts` | Bounded HTTP endpoint, authentication and validation |
| `src/integrations/event-store.ts` | SQLite state and atomic deduplication/batching |
| `src/integrations/worker.ts` | Enrichment, batch flushing and durable delivery |
| `src/index.ts` | Lifecycle wiring, group lookup, outbound send, optional JobManager adapter |
| `src/config.ts` / host secret loading | Explicit opt-in configuration and selected secret access |
| `src/host-actions.ts` | Main-only status and pause/resume controls, if included in v1 |

Keep the initial abstraction small: one provider adapter and one worker, without introducing a generic message broker or making Readwise pretend to be a chat channel.

## Verification and rollout

Tests should cover rejected secrets and oversized bodies, duplicate delivery, crash after persistence before acknowledgment, delayed enrichment, API pagination/rate limits, non-Snipd filtering, batch timer recovery, invalid destinations, and uncertain outbound delivery. Confirm that webhook activity does not alter chat cursors or reuse foreground sessions.

Deploy with delivery paused; register and test the endpoint using Readwise's webhook setup flow, then make one real Snipd snip and verify event → enrichment → batch. The exact test-endpoint payload needs capture during setup before finalizing its handler. Enable main-chat notifications only after that path passes. Synthesis is a separate later toggle.

Implementation choices still to settle: public HTTPS ingress on this installation, desired batching cadence, and whether v1 merely notifies or also synthesizes. The recommended starting point is shared host ingestion with batched main-chat notifications.

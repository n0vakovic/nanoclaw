# Responsiveness and recovery

Recovery commands run on the host, without waiting for a model turn:

Send `/help` or just `?` to rediscover the commands. Telegram also lists them
in its command menu when you type `/`. Help bypasses queued media and agent work.

- `/status`: deployed build identity, running work and queue state.
- `/jobs`: running background work and job IDs.
- `/steer J-id instruction`: queue a direction change for a running job, applied at its next model boundary.
- `/cancel [J-id]`: stop work, retaining diagnostic evidence.
- `/clear`: cancel the current group's work and start its next conversation with a fresh session. Stored messages and memory remain available.
- `/restart`: capture an incident before restarting NanoClaw; restricted to the main group's owner.

Research/background jobs use separate sessions so the foreground conversation can continue. A reset is a recovery action, not a root-cause diagnosis. Each destructive recovery must successfully persist an incident before proceeding. If the state directory is unwritable, the command reports the failure rather than claiming evidence was saved.

All recovery commands currently require the owner identity bound to the registered private main Telegram chat. `/restart` additionally requires that chat as its destination. `/cancel` without an ID stops that chat's foreground work; `/cancel J-id` selects a detached job. A clear preserves the old session files and archives pending input; it does not erase group memory or stored messages. Cancellation cannot undo external actions already performed.

Scheduled tasks now run with independent sessions and input directories, sharing group memory files but never resuming the foreground SDK session. This applies to older tasks marked `context_mode=group` as well. Work that needs earlier conversational detail must read memory or include that context in its prompt. Foreground work has queue priority and one reserved container slot when the concurrency limit is at least two. At a limit of one, simultaneous foreground/background execution is impossible.

Jobs persist in `store/agent-jobs.db`. Queued jobs survive restart; previously running jobs become interrupted and are not automatically replayed. Results remain queryable with `/status J-id`. Outbound delivery records ambiguity rather than blindly resending after a crash. Steering is cooperative; cancellation stops the selected container and does not report success until the queue observes completion.

Telegram ordinary updates are durably journaled outside container mounts before polling proceeds. A separate serial worker preserves their order, while recovery commands bypass slow media processing. Handler errors retry once, then preserve the raw update in a `.failed` file, report an incident and let later messages proceed. Initial journal write failure stops polling so an unrecorded update is not acknowledged. Successful `.done` receipts prevent duplicate processing across restart; automatic journal retention is intentionally not implemented yet.

The host connects Telegram in degraded mode when Docker is unavailable: messages remain stored, `/status` and recovery commands work, and execution resumes only after bounded runtime checks and orphan reconciliation. The independent supervisor covers a hung host event loop; it does not make an unresponsive provider respond.

## Host diagnostic records

`NANOCLAW_STATE_DIR` defaults to `~/.local/state/nanoclaw`. Keep this directory outside agent/container mounts. The worker atomically writes `heartbeat.json` and incident JSON files under `incidents/`, with files mode 0600 and new directories mode 0700. Incidents contain build identity and an explicit allowlist of operational metadata: identifiers, cursor, execution phase, bounded queue state, error codes and exit status. They exclude prompts, message bodies, raw error strings, command arguments and environment variables. Queue evidence is capped at 100 groups. Incident files persist across restarts and clears; there is no automatic deletion.

The incident ID correlates recovery actions with their saved snapshot. Operational identifiers can still be sensitive; do not publish incident files without reviewing them. Consult journal and existing execution logs locally for further diagnosis. The snapshot establishes what the host knew before a reset, not a guaranteed underlying cause.

## Deployment identity

`npm run build` stamps `dist/build-info.json` with the commit SHA, branch, build timestamp and dirty-checkout flag. Source/dev execution without a stamped build reports `unknown` rather than guessing from the current checkout.

`scripts/restart.sh` restarts the existing deployed build. It never compiles the current checkout. `scripts/deploy-main.sh` requires clean, committed `main`, runs typechecking and tests, builds and then restarts the user service. Failed checks stop deployment. An active systemd process alone does not prove Telegram is healthy; verify `/status` and the journal after deployment.

## Independent supervisor

`scripts/recovery-supervisor.mjs` runs outside the worker, once per minute via a systemd user timer. It does not poll Telegram and needs no bot token. Use the same `NANOCLAW_STATE_DIR` in the worker and supervisor. The repository's `dist/recovery.js` must exist before enabling it.

The supervisor allows two minutes for startup and heartbeat age. It captures an incident before restarting an active worker whose heartbeat is missing or stale. Restarts are limited to three per hour, at least five minutes apart. It records failed worker states but leaves crash retries to the worker's systemd `Restart=on-failure` policy. An intentionally stopped worker stays stopped. This avoids a second infinite restart loop when prerequisites such as Docker are unavailable.

Example user unit, with the repository path replaced by the actual checkout:

```ini
# ~/.config/systemd/user/nanoclaw-recovery.service
[Unit]
Description=NanoClaw independent recovery check

[Service]
Type=oneshot
WorkingDirectory=/absolute/path/to/nanoclaw
ExecStart=/usr/bin/node /absolute/path/to/nanoclaw/scripts/recovery-supervisor.mjs
TimeoutStartSec=45
UMask=0077
```

```ini
# ~/.config/systemd/user/nanoclaw-recovery.timer
[Unit]
Description=Check NanoClaw worker liveness

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
Unit=nanoclaw-recovery.service

[Install]
WantedBy=timers.target
```

Enable using `systemctl --user daemon-reload` and `systemctl --user enable --now nanoclaw-recovery.timer`. Inspect with `journalctl --user -u nanoclaw-recovery.service`. This checks host event-loop liveness; provider/model progress needs worker execution deadlines and queue evidence. An out-of-process timer cannot accept chat commands when the Telegram worker is fully down. Local recovery remains `scripts/restart.sh` plus the systemd journal.


## Foreground failure diagnosis

A failed SDK result is captured immediately, before the container's idle shutdown.
Incidents include the SDK result UUID, model, failure category and current message
cursor when available. A cursor can cover multiple inputs; the result UUID identifies
the SDK result without pretending it is the initial Telegram message. Raw SDK error
details are logged immediately in the host log as `Streamed agent failure`, with
known configured credentials redacted and text bounded to 4,000 characters. Search
that entry by result UUID or container name; do not publish raw logs without review.

`/status` shows the latest foreground incident and whether a subsequent successful
turn was recorded, plus whether the queue currently has a retry scheduled. The
summary survives restart in `foreground-failures/` under the host state directory,
with the same permissions as incidents. Successful turns clear the in-memory failure
flag; a later normal idle shutdown does not send another failure notice. Recovery
does not imply the originally failed work was completed, only that a later turn
succeeded. Existing cursor/replay protection remains in place.

## Telegram attachment recovery

Documents (including PDFs and images sent as files), audio files and videos are
saved under `/workspace/ipc/media/` before their message is delivered to the agent.
Filenames include the Telegram message ID, are sanitized, and are written atomically.
Downloads are bounded to 20 MiB and checked against the supplied file size. Ordinary
photos retain their existing image handler; voice notes retain their transcription
and recovery handler. Audio/video attachments are saved without automatic transcription.

Host-only `telegram-media/<chat hash>/<message ID>.json` records retain the Telegram
file reference before download and its success/failure category afterward. This lets
an operator retry `getFile` and the download even after ingress clears a processed
update. Never put the bot token in those records. Failed downloads throw into the
existing ingress retry/incident path instead of telling the agent a file arrived.
These records currently have no automatic retention cleanup.

Before this handler existed, documents were stored as filename-only placeholders;
successful ingress receipts contain no original update. Recovering such an old
attachment requires its file ID from another retained source or a user-authorized
Telegram forward/resend. A temporary forward returns the document file ID; download
and verify the file, then delete only the temporary copy. Keep the original message.

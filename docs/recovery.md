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

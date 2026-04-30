# Migration thoughts — v1 → v2

Notes from a session investigating the upstream sync failure and what it would take to migrate to v2.

## Why the auto-sync was failing

`qwibitai/nanoclaw` (upstream) is **882 commits ahead** of this fork and is now **v2**, a ground-up rewrite. The v2 CLAUDE.md explicitly halts merge attempts:

> "This is NanoClaw v2, a ground-up rewrite with breaking changes throughout. It cannot be merged into an existing v1 install."

The scheduled `fork-sync-skills.yml` workflow tried `git merge upstream/main` every 6 hours and filed a fresh `Upstream sync failed` issue on each failure (no dedup). 158 issues piled up.

**Action taken this session:**
- Disabled schedule/push/repository_dispatch triggers on the workflow (kept `workflow_dispatch` for manual)
- Bulk-closed all 158 open `upstream-sync` issues
- Committed and pushed (`96860a0`) on this machine — **needs `git pull` on znacharch**

## v2 vs v1 — what actually changed

| Concern | v1 | v2 |
|---|---|---|
| Host ↔ container IPC | File watcher (`src/ipc.ts`) | Two SQLite DBs per session (`inbound.db` / `outbound.db`) |
| Container scope | Per-group | Per-session |
| Entity model | Groups + channels (flat) | `users` → `user_roles` → `agent_groups` ↔ `messaging_groups` → `sessions` |
| Privilege | Group-level | User-level (owner / admin scoped or global) |
| Channels | Self-registered in `src/channels/` | Skill-installable from sibling repos (`channels` branch) |
| Providers | Claude Agent SDK only | Claude / OpenCode / Codex / Ollama (skill-installable) |
| Credentials | `.env` + per-channel auth dirs | OneCLI vault, injected at request time |
| Self-mod | Not really | `install_packages` / `add_mcp_server` with admin approval |

There is no `migrate-v2.sh` despite the v2 CLAUDE.md banner mentioning it. The actual migration mechanism is the **`/migrate-nanoclaw` skill** (intent-based, not merge-based):

1. Sub-agents diff the fork against upstream base, identify customizations
2. Writes `.nanoclaw-migrations/guide.md`
3. Checks out clean v2 in a worktree
4. Replays customizations on the clean base from the guide
5. Explicitly **does not touch** `groups/`, `store/`, `data/`, `.env`

## Real install state (znacharch)

- **Running** — `nanoclaw.service` (systemd user), active since Apr 30
- Path: `/home/milan/coding/_third_party/nanoclaw`, config at `~/.config/nanoclaw`
- Same commit as local pre-push (`2415006`)
- **Three groups**: `global`, `main`, `telegram_main` — `telegram_main` exists only on the server, not in the repo (uncommitted state on the prod machine)
- One channel wired: **Telegram**. WhatsApp / Slack / Discord / Gmail are commented out in `src/channels/index.ts`.
- Extra git remotes for `nanoclaw-telegram` and `nanoclaw-whatsapp` (qwibitai sibling repos) — the skill-installable channel pattern is already partially adopted in v1
- Data: `data/sessions/`, `data/ipc/`, `data/env/`, `data/nanoclaw.db` (0 bytes), `store/messages.db` (real history)
- `ELEVENLABS_VOICE_ID` set — voice/TTS in use
- `ASSISTANT_NAME=DamRass` (matches groups CLAUDE.md)

## Custom code on top of upstream base

To be re-applied on v2:
- `githubIssue` host action (per-repo allowlist, mtime cache, pagination)
- `syncRepos` upstream branch mirroring (with CoachEx upstream branch support)
- Telegram photo message support

## Migration plan — split-channel on znacharch

The realistic shape, given prod is on znacharch and there's only one channel currently wired:

1. **Sync prerequisites first:**
   - `git pull` on znacharch to get the workflow disable + recent commits
   - Decide what to do with `telegram_main` group on the server — commit it back, or capture its content for v2 recreation

2. **Run `/migrate-nanoclaw` locally** to generate the migration guide. Inspect the guide before doing anything to znacharch.

3. **Deploy v2 to znacharch in a parallel directory** (`~/coding/_third_party/nanoclaw-v2`), separate systemd unit `nanoclaw-v2.service`. v1 keeps running.

4. **Pair WhatsApp on v2** (fresh QR — new identity, no conflict with v1 since v1 isn't on WhatsApp). v1 keeps Telegram.

5. **Run split for a real validation window.** v1 = prod (Telegram), v2 = real but contained (WhatsApp). Not test traffic — actual daily use on WhatsApp.

6. **Cutover:** stop v1, swap v2 onto the production Telegram bot token, keep WhatsApp paired throughout.

7. **Retire v1** once v2 is stable for some period.

## State carry-over — what to actually move

v2's schema is incompatible with v1's. The migration skill explicitly does not touch data dirs. Three tiers depending on what matters:

- **Tier A — persona + memory only.** `cp groups/<name>/CLAUDE.md` into v2's matching agent group. Trivial.
- **Tier B — also message history.** One-time importer from `store/messages.db` to v2's per-session DBs. Real work; schema mismatch (flat → two-DB-per-session split). Manageable as a script.
- **Tier C — everything (scheduled tasks, pending approvals, mid-flight IPC).** Impractical given schema divergence.

## Open questions

- What state actually needs to be preserved? (Tier A is probably enough for a personal assistant.)
- `telegram_main` group — should it be committed back to the repo, or just recreated in v2?
- `data/nanoclaw.db` is 0 bytes — investigate what's actually in `data/sessions/` and `store/messages.db` before deciding the importer story.
- Are scheduled tasks load-bearing? If so, plan their re-creation in v2.

## Pre-migration housekeeping (independent of v2 decision)

- Pull workflow disable + recent commits onto znacharch
- Decide on `telegram_main` (commit back or document)
- Reconcile or document the `nanoclaw-telegram` / `nanoclaw-whatsapp` sibling-repo remotes

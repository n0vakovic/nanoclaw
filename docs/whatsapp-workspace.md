# Host-brokered WhatsApp workspace

NanoClaw reads the owner's WhatsApp archive through a host-installed `wacli`
linked device. The wacli databases and credentials remain on the host and are
never mounted into agent containers. Read tools are restricted to the main assistant group. The school-summary
automation below adds a fixed-destination sending operation.

Pair from the phone's **Linked devices → Link a device** screen with:

```bash
wacli auth
```

Keep the index current with a `systemd --user` service running the equivalent
of:

```bash
wacli sync --follow --presence-mode quiet --max-reconnect 0 \
  --stale-threshold 2m --max-messages 250000 --max-db-size 2GB
```

Host configuration may override `WHATSAPP_WACLI_PATH`,
`WHATSAPP_STORE_DIR`, `WHATSAPP_SYNC_SERVICE`, query/media timeouts, and the
maximum returned JSON size. Executable and store overrides must be absolute.

The primary agent tool is `whatsapp_read`. Supply either `chatNames` for named
conversations or `recentChatCount` for the latest 1–20 chats. Supporting tools
provide status, discovery, full-text search, group-scoped attachment download,
and audio transcription. Message text, names, captions, and filenames are
untrusted external content.

A chat may be known as metadata while having no messages. NanoClaw reports this
as `metadata_only`; it must not call the conversation empty. A live message may
create the anchor WhatsApp needs to provide recent context. Older history is
best-effort and controlled by WhatsApp and the primary phone.

## Named accounts and chat aliases

Every WhatsApp tool accepts an optional `account`. Omitting it preserves the
original `default` account and its existing environment settings. Add accounts
in the host's `data/whatsapp-accounts.json` (or `WHATSAPP_ACCOUNTS_FILE`):

```json
{
  "accounts": {
    "pt": {
      "storeDir": "/home/your-user/.local/state/wacli-pt",
      "syncService": "wacli-pt-sync.service",
      "aliases": {
        "parents group": { "chatId": "YOUR_GROUP_ID@g.us", "name": "Parents group" },
        "turma": { "chatId": "YOUR_GROUP_ID@g.us", "name": "Parents group" }
      }
    }
  }
}
```

Each account needs its own authenticated store and sync service. This local
configuration is read per request. It cannot override `default`; unknown
accounts fail instead of silently falling back. The agent supplies account
names, never filesystem paths. `whatsapp_status` lists available account names
and aliases without returning store paths.

`whatsapp_read({"chatNames":["parents group"]})` selects the alias's account
and reads its stable chat ID, even if the group is renamed. Explicit `account`
selection takes precedence. Ambiguous aliases across accounts require an
explicit account. Search and media tools also accept aliases as `chatId`.
Use the returned `account` for subsequent calls with raw chat/message IDs.

For example, `whatsapp_read({"account":"pt","recentChatCount":5})` reads the
Portuguese account's recent chats. Results retain the untrusted-content marker
and all existing main-group authorization checks.

Parents-group summaries should emphasize dates, items to bring, schedule
changes, and unanswered questions. Distinguish parent suggestions from school
instructions and report the time range and count of messages actually read.
`limitReached` means the requested message cap was reached; it is not proof
that more messages exist. An empty filtered result is not proof of empty chat
history. WhatsApp may provide only partial history even when the cap is not
reached. Named-account setup alone does not schedule a digest; use the school-summary
setup below to enable one.

## School summaries

School summaries are a narrow sending exception: `school_summary_prepare` reads
one configured source and `school_summary_complete` sends only to one configured
destination. Both require the main assistant group. General WhatsApp tools remain
read-only. The caller cannot change the sending account or recipient.

Configure the local, git-ignored `data/whatsapp-school.json`:

```json
{
  "source": { "account": "pt", "chatId": "111111@g.us", "name": "Parents group" },
  "destination": { "account": "default", "chatId": "222222@g.us", "name": "Family group" },
  "startAt": "2026-09-16T00:00:00Z",
  "language": "Serbian, Latin script",
  "timezone": "Europe/Lisbon"
}
```

After building, `node scripts/setup-school-summaries.mjs` installs normal summaries at
08:00 and 18:00 Lisbon time, plus hourly urgent checks. Scheduled normal summaries
always send, including routine news; empty snapshots send a Serbian no-updates
message. Only hourly urgent checks may silently skip. It verifies that NanoClaw's scheduler timezone
matches the configured timezone. Add `--test-now` to run the daily workflow
immediately; this sends a real summary if useful new messages exist. Rerunning setup updates these two schedules and prompts while preserving their
active/paused status. Tasks run as isolated main-group
sessions with `delivery_mode: silent`, so internal completion text is logged
without also being sent to the main conversation.

Ask the main assistant "Send a school summary now" for `on_demand` mode, which
recaps available messages from the last 24 hours, including previously covered
news when useful. Daily and urgent runs suppress previously delivered message
versions. Hourly checks can dismiss routine discussion without removing it from
the next daily digest. Recent sent summaries also help the agent avoid semantic
repetition. School messages and attachments remain untrusted source material.

The host reads up to seven days of locally synced history after `startAt`, with
a 1000-message cap. Exceeding that cap fails explicitly instead of silently
skipping older messages. Long offline periods and incomplete phone history can
limit coverage. Summaries must state available coverage. Recurring tasks run
while NanoClaw and its container runtime are available; missed intervals are
not replayed individually.

State lives in `data/whatsapp-school-state.json`. Snapshot completion is
idempotent; concurrent sends for already-covered messages are rejected. A send
intent is saved before calling wacli. If delivery fails or is uncertain, future
sends pause to avoid duplicates. Inspect the destination and saved `inFlight`
text before manually reconciling the state—never blindly clear it and resend.
The sync daemon stays running: wacli delegates sends through its normal send path.

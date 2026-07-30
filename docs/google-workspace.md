# Host-brokered Google Workspace

NanoClaw exposes narrow Google Calendar actions plus read-only Drive, Docs, and
Gmail access through the host. The `gog` binary and its credentials stay
outside agent containers. There is no generic command or argument passthrough.

## Configure

Copy `docs/google-policy.example.json` to:

```text
~/.config/nanoclaw/google-policy.json
```

Replace all placeholders. Account and resource aliases are the only names
agents may use; raw account emails, calendar IDs, and Drive folder IDs remain
host-side.

Calendar write modes are:

- `deny`: unavailable
- `manual`: create an immutable, expiring proposal in SQLite and send it to
  the configured private Telegram chat
- `auto`: reserved for a future constrained preapproval release; currently
  fails closed

The initial policy uses `manual` for every Calendar write. Missing policy,
aliases, or permissions fail closed.

## Approval flow

The private Telegram approval message includes native **Approve** and **Reject**
buttons. Button callbacks pass through the same host authorization boundary as
typed commands, and the controls are removed after a recorded decision.
`/approve G-XXXXXXXXXX` and `/reject G-XXXXXXXXXX` remain available as recovery
fallbacks. Only the configured private Telegram chat and exact Telegram user ID
are accepted. Natural-language confirmation is ignored.

Approval freezes and hashes the exact payload and resolved account/calendar
target. Calendar updates also freeze an event snapshot. A changed event or
policy target must be proposed again. Execution runs in the background so
Telegram's update loop does not block, and the final result is routed to the
requesting chat.

Pending approvals expire after ten minutes by default. Approved work resumes
after a restart. Work that was already executing is not replayed automatically
because the external write may have succeeded before the process stopped.

## Hard invariants

- Calendar attendees and invitation changes are not accepted.
- Calendar notifications are always `none`.
- Deletes, sharing changes, moves, Gmail sends/replies/forwards, label changes,
  draft mutations, and arbitrary `gog` commands have no exposed action.
- Reads force `--readonly`, `--no-input`, bounded output, and untrusted-content
  wrapping.
- Gmail message and thread reads additionally force content sanitization.
- Writes execute only the payload stored in SQLite, never command arguments
  supplied during approval.
- Ambiguous mutation timeouts become `needs_reconciliation`; they are never
  reported as definitive failures or automatically replayed.

## Agent tools

- `google_calendar_events`
- `google_calendar_propose_create`
- `google_calendar_propose_update`
- `google_docs_read`
- `google_drive_search`
- `google_drive_list_folder`
- `google_gmail_search`
- `google_gmail_recent_drafts`
- `google_gmail_message_read`
- `google_gmail_thread_read`
- `google_gmail_workspace_links`

Proposal receipts mean a write is pending; they are never proof that the
external mutation succeeded.

Docs create/append/replace and Drive uploads remain tracked in GitHub issues
#189 and #190. They are intentionally not exposed until document concurrency,
folder scoping, and host-owned file staging are implemented.

Drive search provides read-only discovery across files visible to the
configured account. Folder listing accepts a folder ID and can only return its
direct children; neither tool can download, move, share, or modify files. A
discovered Google Doc ID can be passed to `google_docs_read`.

Gmail search accepts standard Gmail query syntax. Draft listing is a fixed
`in:drafts` search ordered by Gmail; the returned message ID can be passed to
`google_gmail_message_read` to retrieve the latest server-autosaved body.
Unsynced text that exists only in an open browser tab is not available.
Attachment download is deliberately not exposed yet.

Sanitized Gmail reads may omit links. `google_gmail_workspace_links` inspects
the original thread only inside the host broker, discards all message text and
HTML, rejects non-HTTPS and non-Google hosts, and returns canonical
`drive.google.com` / `docs.google.com` resource IDs and URLs. This preserves the
sanitizer boundary while allowing an agent to recover a shared file reference.

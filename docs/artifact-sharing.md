# Artifact sharing

NanoClaw can accept files from a remote shell or snapshot files created by Ras, serve private previews over Tailscale, and send a durable Telegram notification. No agent turn is required for remote uploads or notifications.

## Host setup (Linux)

The preview host uses Linux descriptor-relative reads (`/proc/self/fd`) to avoid symlink races. The standalone client supports macOS and Linux with Node 22 or later.

Install dependencies and build the host and agent runner. Add these settings to the host `.env`, using its actual Tailscale DNS name:

```dotenv
ARTIFACTS_ENABLED=1
ARTIFACTS_API_ORIGIN=https://HOST.TAILNET.ts.net
ARTIFACTS_PREVIEW_ORIGIN=https://HOST.TAILNET.ts.net:8443
ARTIFACTS_API_PORT=8787
ARTIFACTS_PREVIEW_PORT=8788
# Optional; defaults shown:
ARTIFACTS_TTL_DAYS=7
ARTIFACTS_MAX_BYTES=52428800
ARTIFACTS_QUOTA_BYTES=2147483648
# Default directory: ~/.local/share/nanoclaw/artifacts
# Must remain outside all agent mounts; do not put credentials/store in the project.
# ARTIFACTS_DIRECTORY=/host/private/path/artifacts
# Optional gist publication, using the host's existing gh authentication:
ARTIFACTS_GIST_ENABLED=1
ARTIFACTS_GH_BIN=/usr/bin/gh
```

Inspect `tailscale serve status` first. Preserve unrelated routes. With HTTPS enabled for the tailnet:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve --bg --https=8443 http://127.0.0.1:8788
```

Serve may require a tailnet administrator to enable HTTPS through a URL it prints. This uses private Serve, not public Funnel. The two loopback listeners and HTTPS origins must differ. Tailnet access controls must permit the intended Mac and reviewing phone. Restart NanoClaw after changing configuration. Disabled configuration leaves existing behavior unchanged.

The API rejects browser-origin requests and requires bearer credentials. Preview content has no cookies or credentials and uses a CSP sandbox without `allow-same-origin`. Do not merge the two origins or mount the artifact directory into an agent container.

## Mac/client setup

The client directory is a dependency-free package, separate from the host:

```sh
# From a checkout, or after copying just packages/nanoclaw-preview to your Mac:
npm install -g ./packages/nanoclaw-preview
nanoclaw --help
```

Issue a credential on the host, binding a unique client label to the owner's private main Telegram chat:

```sh
node dist/artifact-admin.js issue work-mac
# Defaults to the registered private main Telegram chat; an explicit tg:CHAT_ID is optional.
```

Transfer that output securely to the Mac and pass it through stdin (not a command argument or checked-in file):

```sh
nanoclaw connect https://HOST.TAILNET.ts.net --token-stdin
# Paste the token on stdin, then EOF; alternatively pipe from a password manager.
```

A file with mode 0600 stores the token and endpoint at `~/.config/nanoclaw-preview/config.json`. `NANOCLAW_CONFIG` overrides the path. Automation may supply `NANOCLAW_ENDPOINT` and `NANOCLAW_TOKEN`. Revoke every credential for a client with `node dist/artifact-admin.js revoke work-mac`. Labels are ownership identities: reuse a label only for the same client/destination.

```sh
nanoclaw preview ./report.html --title 'Research report'
nanoclaw preview ./dist --entry index.html --title 'Dashboard'
nanoclaw preview ./diagram.png --ttl 3d --json
nanoclaw preview --url https://example.com/report --title 'Existing report'
nanoclaw status SHARE_ID --json
nanoclaw pin SHARE_ID
nanoclaw unpin SHARE_ID
nanoclaw delete SHARE_ID
```

Optional explicit source labels: `--machine`, `--project`, `--session`. No repository or session content is collected implicitly. File/folder upload limits: 50 MiB and 1,000 files by default. The lightweight client currently retains a 50 MiB cap even if the server limit is increased. Hidden paths, `.env*`, `.git`, node_modules, key files, symlinks, and special files are rejected rather than silently omitted. Upload a prepared export folder.

An accepted upload returns its URL immediately; `notification: pending` means Telegram delivery is still queued, not that the upload failed. Automatic retries reuse one idempotency key. Explicitly invoking the CLI again creates a new snapshot. The CLI does not persist retry state across a terminated process. JSON output is on stdout; upload progress/errors are on stderr.

## Ras and Telegram

Ras calls `share_artifact({path: '/workspace/group/report.html', title: 'Report'})` for a finished file or static folder (folders use `index.html` unless they contain only one file; optional `entry` overrides this). The host copies a snapshot from that group's workspace into the same store. Original files remain unchanged. Ras should not send another notification for the same share.

Reply to the host notification with exactly:

- `keep this` or `pin this`
- `unpin this`
- `delete this share`
- `publish this as a secret gist`
- `publish this as a public gist`

These deterministic phrases bypass the model. Explicit equivalents: `/share status ID`, `/share pin ID`, `/share unpin ID`, `/share delete ID`, `/share publish ID secret|public`. Owner controls are restricted to the private main chat, verified against the sender ID. Message associations come from stored Telegram message IDs, not quoted content. Arbitrary natural-language paraphrases are not interpreted by the host. Publishing without a visibility asks for the missing choice.

Gist publishing is optional. Supported: flat, nonempty UTF-8 text files (up to 1 MiB combined), with self-contained HTML. Binary files, nested assets, and HTML with linked dependencies are rejected. The self-contained check is conservative; the service does not rewrite or bundle HTML. Secret gists are unlisted, not private. Public gists cannot be made secret again. HTML preview links use the external htmlpreview service; that service receives access to the gist. Publishing makes a separate snapshot and does not modify later private uploads. Local deletion never deletes published gists; manage them on GitHub.

A lost GitHub response is marked uncertain. Repeating the promotion reconciles up to 1,000 recent owned gists by a unique marker before returning a result. If no match can be established, it does not create a second gist. An operator should inspect GitHub and the `promotions` table; only clear an uncertain record after establishing no publication occurred. No automatic external publication test is performed.

## Previews and cleanup

HTML/classic JavaScript, CSS, images, and PDFs use browser-native viewing; unsupported types download. A single file has a download URL. Folder-wide ZIP downloads and SPA routing are not implemented. Relative assets are preserved. The sandbox blocks forms, popup/top navigation, storage/service workers, iframe embedding, and fetch; module scripts and other origin-sensitive apps may not work. This is for static previews, not arbitrary full web apps. Remote HTTPS scripts/styles/images can load; uploads are not made self-contained automatically.

A fixed seven-day default TTL starts at creation. Reading does not extend it. Pinning removes expiry; unpinning starts a fresh configured TTL. Cleanup runs hourly and at startup, and requests enforce expiry immediately. Deleted/expired managed bytes are removed; retries retain a small tombstone for 30 days. Published gist bookkeeping remains until managed manually. Active and pinned shares count against quota and are never silently evicted. Uploads are serialized, staging is bounded by the per-upload limit, and expired bytes are reclaimed before quota rejection. Only one host process may own this store.

The outbox retries Telegram failures up to 20 times with increasing delay capped at one hour. `/share status ID` exposes pending/sent/failed. A crash between Telegram acceptance and saving the message ID can produce a duplicate notification; exactly-once Telegram delivery is not promised. To retry a permanently failed notification, an operator can reset that artifact's notification/attempts/next fields after fixing delivery. There is no self-service retry command yet.

Back up the private artifact directory, including SQLite/WAL consistently (stop service or use SQLite backup), if pinned shares matter. Avoid copying live SQLite files without their WAL. Forwarded external URLs are never fetched; deleting their NanoClaw record does not revoke them.

## Troubleshooting

- Tailscale offline/access denied: connect the uploading or reviewing device and check tailnet rules.
- HTTPS connection refused/502: check Serve mappings, host status, and local ports 8787/8788.
- HTTP 401: reconnect with a current credential; never expose the Telegram bot token.
- HTTP 429: one upload is already active; the CLI retries briefly.
- HTTP 413: file count/size or storage quota exceeded. Delete shares or increase capacity.
- HTTP 410: the share expired or was deleted; reading cannot revive it.
- Telegram is pending/failed: upload remains durable; inspect host logs/status and bot connectivity.
- Telegram rich link previews cannot crawl this private service. Open the link with Tailscale connected.

Validation: `npm run typecheck`, `npm test`, `npm run build`, `npm run build --prefix container/agent-runner`, and `node --check packages/nanoclaw-preview/cli.mjs`. Integration tests exercise real loopback HTTP, not GitHub or Telegram accounts.

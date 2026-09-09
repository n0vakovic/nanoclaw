# Host-brokered WhatsApp workspace

NanoClaw reads the owner's WhatsApp archive through a host-installed `wacli`
linked device. The wacli databases and credentials remain on the host and are
never mounted into agent containers. All exposed operations are read-only and
restricted to the main assistant group.

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

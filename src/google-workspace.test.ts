import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-google-test-'));
  process.env.GOOGLE_POLICY_PATH = path.join(tempDir, 'policy.json');
  process.env.GOG_ARGS_LOG = path.join(tempDir, 'gog-args.log');
  vi.resetModules();
});

afterEach(() => {
  delete process.env.GOOGLE_POLICY_PATH;
  delete process.env.GOG_ARGS_LOG;
  delete process.env.GOG_FAKE_FAIL_CREATE;
  fs.rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function installFakeGog(): string {
  const fakePath = path.join(tempDir, 'fake-gog.mjs');
  fs.writeFileSync(
    fakePath,
    `#!/usr/bin/env node
import fs from 'fs';
fs.appendFileSync(process.env.GOG_ARGS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const args = process.argv.slice(2);
if (args[0] === 'calendar' && args[1] === 'create') {
  if (process.env.GOG_FAKE_FAIL_CREATE === '1') process.exit(2);
  console.log(JSON.stringify({ id: 'event-created' }));
} else if (args[0] === 'calendar' && args[1] === 'event') {
  console.log(JSON.stringify({ id: args[3], attendees: [] }));
} else {
  console.log(JSON.stringify({ items: [] }));
}
`,
    { mode: 0o700 },
  );
  return fakePath;
}

function writePolicy(gogPath: string): void {
  fs.writeFileSync(
    process.env.GOOGLE_POLICY_PATH!,
    JSON.stringify({
      version: 1,
      gogPath,
      approvals: {
        telegramChatJid: 'tg:100',
        telegramUserIds: ['42'],
        ttlSeconds: 600,
      },
      accounts: {
        work: { email: 'work@example.com', groups: ['main'] },
      },
      calendars: {
        work_primary: {
          account: 'work',
          calendarId: 'primary',
          groups: ['main'],
          read: true,
          create: 'manual',
          update: 'manual',
        },
      },
      docs: {
        work_docs: {
          account: 'work',
          groups: ['main'],
          read: true,
        },
      },
      drive: {
        work_drive: {
          account: 'work',
          groups: ['main'],
          search: true,
          list: true,
        },
      },
      gmail: {
        work_mail: {
          account: 'work',
          groups: ['main'],
          search: true,
          read: true,
        },
      },
    }),
  );
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('Google host broker', () => {
  it('forces read-only safety flags on calendar reads', async () => {
    writePolicy(installFakeGog());
    const google = await import('./google-workspace.js');

    await google.googleCalendarList(
      { calendar: 'work_primary', from: 'today', to: 'tomorrow' },
      'main',
    );

    const argv = JSON.parse(
      fs.readFileSync(process.env.GOG_ARGS_LOG!, 'utf8').trim(),
    ) as string[];
    expect(argv.slice(0, 3)).toEqual(['calendar', 'events', 'primary']);
    expect(argv).toContain('--readonly');
    expect(argv).toContain('--wrap-untrusted');
    expect(argv).toContain('--no-input');
    expect(argv).toContain('--gmail-no-send');
  });

  it('searches Drive through the exact read-only command', async () => {
    writePolicy(installFakeGog());
    const google = await import('./google-workspace.js');

    await google.googleDriveSearch(
      {
        drive: 'work_drive',
        query: 'coaching call Sahra',
        max: 30,
      },
      'main',
    );

    const argv = JSON.parse(
      fs.readFileSync(process.env.GOG_ARGS_LOG!, 'utf8').trim(),
    ) as string[];
    expect(argv.slice(0, 3)).toEqual([
      'drive',
      'search',
      'coaching call Sahra',
    ]);
    expect(argv).toContain('--max');
    expect(argv).toContain('30');
    expect(argv).toContain('--readonly');
    expect(argv).toContain('--wrap-untrusted');
    expect(argv).toContain('--no-input');
    expect(argv).toContain('drive.search');
  });

  it('lists only the requested Drive folder through a read-only command', async () => {
    writePolicy(installFakeGog());
    const google = await import('./google-workspace.js');

    await google.googleDriveListFolder(
      {
        drive: 'work_drive',
        folderId: 'folder_0123456789',
        max: 40,
      },
      'main',
    );

    const argv = JSON.parse(
      fs.readFileSync(process.env.GOG_ARGS_LOG!, 'utf8').trim(),
    ) as string[];
    expect(argv.slice(0, 2)).toEqual(['drive', 'ls']);
    expect(argv).toContain('--parent');
    expect(argv).toContain('folder_0123456789');
    expect(argv).toContain('--max');
    expect(argv).toContain('40');
    expect(argv).toContain('--readonly');
    expect(argv).toContain('--wrap-untrusted');
    expect(argv).toContain('drive.ls');
  });

  it('searches Gmail messages through the exact read-only command', async () => {
    writePolicy(installFakeGog());
    const google = await import('./google-workspace.js');

    await google.googleGmailSearch(
      {
        gmail: 'work_mail',
        query: 'from:person@example.com newer_than:30d',
        max: 12,
      },
      'main',
    );

    const argv = JSON.parse(
      fs.readFileSync(process.env.GOG_ARGS_LOG!, 'utf8').trim(),
    ) as string[];
    expect(argv.slice(0, 4)).toEqual([
      'gmail',
      'messages',
      'search',
      'from:person@example.com newer_than:30d',
    ]);
    expect(argv).toContain('12');
    expect(argv).toContain('--readonly');
    expect(argv).toContain('--wrap-untrusted');
    expect(argv).toContain('--gmail-no-send');
    expect(argv).toContain('gmail.messages.search');
    expect(argv).not.toContain('--include-body');
  });

  it('lists drafts with a fixed read-only Gmail query', async () => {
    writePolicy(installFakeGog());
    const google = await import('./google-workspace.js');

    await google.googleGmailRecentDrafts(
      { gmail: 'work_mail', max: 1 },
      'main',
    );

    const argv = JSON.parse(
      fs.readFileSync(process.env.GOG_ARGS_LOG!, 'utf8').trim(),
    ) as string[];
    expect(argv.slice(0, 4)).toEqual([
      'gmail',
      'messages',
      'search',
      'in:drafts',
    ]);
    expect(argv).toContain('--max');
    expect(argv).toContain('1');
    expect(argv).toContain('--readonly');
    expect(argv).toContain('gmail.messages.search');
  });

  it('reads Gmail messages with content sanitization and no mutation flags', async () => {
    writePolicy(installFakeGog());
    const google = await import('./google-workspace.js');

    await google.googleGmailMessageRead(
      { gmail: 'work_mail', messageId: '18abcdef0123456' },
      'main',
    );

    const argv = JSON.parse(
      fs.readFileSync(process.env.GOG_ARGS_LOG!, 'utf8').trim(),
    ) as string[];
    expect(argv.slice(0, 3)).toEqual(['gmail', 'get', '18abcdef0123456']);
    expect(argv).toContain('--sanitize-content');
    expect(argv).toContain('--readonly');
    expect(argv).toContain('--gmail-no-send');
    expect(argv).toContain('gmail.get');
    expect(argv).not.toContain('--download');
  });

  it('reads complete Gmail threads without downloading attachments', async () => {
    writePolicy(installFakeGog());
    const google = await import('./google-workspace.js');

    await google.googleGmailThreadRead(
      { gmail: 'work_mail', threadId: '18abcdef0123456' },
      'main',
    );

    const argv = JSON.parse(
      fs.readFileSync(process.env.GOG_ARGS_LOG!, 'utf8').trim(),
    ) as string[];
    expect(argv.slice(0, 4)).toEqual([
      'gmail',
      'thread',
      'get',
      '18abcdef0123456',
    ]);
    expect(argv).toContain('--full');
    expect(argv).toContain('--sanitize-content');
    expect(argv).toContain('--readonly');
    expect(argv).toContain('gmail.thread.get');
    expect(argv).not.toContain('--download');
  });

  it('extracts only canonical Google Workspace links from raw email data', async () => {
    const google = await import('./google-workspace.js');
    const output = google.extractGoogleWorkspaceLinks(
      JSON.stringify({
        body: `
          <a href="https://drive.google.com/drive/folders/folder_0123456789?usp=sharing">folder</a>
          <a href="https://docs.google.com/document/d/document_0123456789/edit?tab=t.0&amp;usp=sharing">doc</a>
          <a href="https://docs.google.com/forms/d/e/form_0123456789/viewform">form</a>
          https://evil.example/steal
          https://docs.google.com.evil.example/document/d/fake_0123456789/edit
        `,
        nested: {
          duplicate:
            'https://docs.google.com/document/d/document_0123456789/edit',
        },
      }),
    );

    expect(JSON.parse(output)).toEqual({
      links: [
        {
          kind: 'folder',
          id: 'folder_0123456789',
          url: 'https://drive.google.com/drive/folders/folder_0123456789',
        },
        {
          kind: 'document',
          id: 'document_0123456789',
          url: 'https://docs.google.com/document/d/document_0123456789',
        },
        {
          kind: 'form',
          id: 'form_0123456789',
          url: 'https://docs.google.com/forms/d/e/form_0123456789',
        },
      ],
    });
    expect(output).not.toContain('evil.example');
  });

  it('extracts Workspace links on the host without disabling read-only mode', async () => {
    writePolicy(installFakeGog());
    const google = await import('./google-workspace.js');

    await google.googleGmailWorkspaceLinks(
      { gmail: 'work_mail', threadId: '18abcdef0123456' },
      'main',
    );

    const argv = JSON.parse(
      fs.readFileSync(process.env.GOG_ARGS_LOG!, 'utf8').trim(),
    ) as string[];
    expect(argv.slice(0, 4)).toEqual([
      'gmail',
      'thread',
      'get',
      '18abcdef0123456',
    ]);
    expect(argv).toContain('--full');
    expect(argv).toContain('--readonly');
    expect(argv).toContain('--wrap-untrusted');
    expect(argv).toContain('--gmail-no-send');
    expect(argv).toContain('gmail.thread.get');
    expect(argv).not.toContain('--sanitize-content');
    expect(argv).not.toContain('--download');
  });

  it('stores an immutable proposal and executes only after owner approval', async () => {
    writePolicy(installFakeGog());
    const db = await import('./db.js');
    db._initTestDatabase();
    const google = await import('./google-workspace.js');
    const notifications: Array<{
      jid: string;
      text: string;
      approvalId?: string;
    }> = [];

    const receipt = JSON.parse(
      await google.proposeGoogleWrite(
        'calendar.create',
        {
          account: 'work',
          resource: 'work_primary',
          summary: 'Planning',
          from: '2026-08-01T10:00:00+01:00',
          to: '2026-08-01T10:30:00+01:00',
        },
        {
          sourceGroup: 'main',
          sourceChatJid: 'tg:100',
          groupIpcDir: tempDir,
          sendMessage: async (jid, text, approvalId) => {
            notifications.push({ jid, text, approvalId });
          },
        },
      ),
    ) as { approvalId: string };

    expect(fs.existsSync(process.env.GOG_ARGS_LOG!)).toBe(false);
    expect(notifications[0].jid).toBe('tg:100');
    expect(notifications[0].approvalId).toBe(receipt.approvalId);
    expect(db.getGoogleApproval(receipt.approvalId)?.state).toBe('pending');

    const command = await google.handleGoogleApprovalCommand(
      'approve',
      receipt.approvalId,
      'tg:100',
      '42',
      () => tempDir,
      async (jid, text) => {
        notifications.push({ jid, text });
      },
    );
    expect(command.reply).toContain('execution started');

    await waitFor(
      () => db.getGoogleApproval(receipt.approvalId)?.state === 'succeeded',
    );
    const calls = fs
      .readFileSync(process.env.GOG_ARGS_LOG!, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(calls[0].slice(0, 2)).toEqual(['calendar', 'create']);
    expect(calls[0]).toContain('--send-updates');
    expect(calls[0]).toContain('none');
    expect(calls[0]).not.toContain('--attendees');
    expect(calls[1].slice(0, 2)).toEqual(['calendar', 'event']);
  });

  it('rejects fields that could bypass the typed attendee boundary', async () => {
    const google = await import('./google-workspace.js');
    await expect(
      google.proposeGoogleWrite(
        'calendar.create',
        {
          account: 'work',
          resource: 'work_primary',
          summary: 'Unsafe',
          from: '2026-08-01T10:00:00+01:00',
          to: '2026-08-01T10:30:00+01:00',
          attendees: ['person@example.com'],
        },
        {
          sourceGroup: 'main',
          sourceChatJid: 'tg:100',
          groupIpcDir: tempDir,
          sendMessage: async () => {},
        },
      ),
    ).rejects.toThrow('Unsupported Google action fields: attendees');
  });

  it('records an ambiguous mutation failure for reconciliation', async () => {
    process.env.GOG_FAKE_FAIL_CREATE = '1';
    writePolicy(installFakeGog());
    const db = await import('./db.js');
    db._initTestDatabase();
    const google = await import('./google-workspace.js');
    const receipt = JSON.parse(
      await google.proposeGoogleWrite(
        'calendar.create',
        {
          account: 'work',
          resource: 'work_primary',
          summary: 'Uncertain',
          from: '2026-08-01T10:00:00+01:00',
          to: '2026-08-01T10:30:00+01:00',
        },
        {
          sourceGroup: 'main',
          sourceChatJid: 'tg:100',
          groupIpcDir: tempDir,
          sendMessage: async () => {},
        },
      ),
    ) as { approvalId: string };

    await google.handleGoogleApprovalCommand(
      'approve',
      receipt.approvalId,
      'tg:100',
      '42',
      () => tempDir,
      async () => {},
    );
    await waitFor(
      () =>
        db.getGoogleApproval(receipt.approvalId)?.state ===
        'needs_reconciliation',
    );
    const approval = db.getGoogleApproval(receipt.approvalId);
    expect(approval?.payload_json).not.toBeNull();
    expect(approval?.error).toContain('external outcome is unknown');
  });

  it('expires a pending proposal before accepting a delayed decision', async () => {
    writePolicy(installFakeGog());
    const db = await import('./db.js');
    db._initTestDatabase();
    db.createGoogleApproval({
      id: 'G-0123456789',
      source_group: 'main',
      source_chat_jid: 'tg:100',
      operation: 'calendar.create',
      account_alias: 'work',
      resource_alias: 'work_primary',
      payload_json: '{}',
      payload_hash: 'unused-after-expiry',
      summary: 'Expired proposal',
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-01T00:01:00.000Z',
    });
    const google = await import('./google-workspace.js');

    const result = await google.handleGoogleApprovalCommand(
      'approve',
      'G-0123456789',
      'tg:100',
      '42',
      () => tempDir,
      async () => {},
    );

    expect(result.reply).toContain('already expired');
    expect(db.getGoogleApproval('G-0123456789')?.state).toBe('expired');
    expect(fs.existsSync(process.env.GOG_ARGS_LOG!)).toBe(false);
  });
});

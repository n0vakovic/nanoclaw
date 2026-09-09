import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _setWhatsAppExecForTests,
  whatsappRead,
} from './whatsapp-workspace.js';

function envelope(data: unknown) {
  return { stdout: JSON.stringify({ success: true, data, error: null }) };
}

afterEach(() => _setWhatsAppExecForTests());

describe('WhatsApp workspace reads', () => {
  it('forces read-only wacli arguments and resolves an exact named chat', async () => {
    const calls: string[][] = [];
    _setWhatsAppExecForTests(
      vi.fn(async (file, args) => {
        calls.push([file, ...args]);
        if (file === 'systemctl') return { stdout: 'active\n' };
        if (args.includes('chats')) {
          return envelope([
            {
              jid: 'project@g.us',
              name: 'Project Alpha',
              kind: 'group',
              last_message_ts: '2026-09-09T10:00:00Z',
            },
          ]);
        }
        return envelope({
          fts: true,
          messages: [
            {
              MsgID: 'M1',
              Timestamp: '2026-09-09T10:00:00Z',
              Text: 'status',
              FromMe: false,
            },
          ],
        });
      }),
    );

    const result = JSON.parse(
      await whatsappRead({ chatNames: ['project alpha'] }),
    );
    expect(result.chats[0]).toMatchObject({
      name: 'Project Alpha',
      coverage: 'ready',
    });
    expect(result.chats[0].messages).toHaveLength(1);
    for (const call of calls.filter(([file]) => file !== 'systemctl')) {
      expect(call.slice(1, 6)).toEqual([
        '--store',
        expect.any(String),
        '--read-only',
        '--json',
        expect.any(String),
      ]);
    }
  });

  it('sorts recent chats by message time and excludes metadata-only rows', async () => {
    _setWhatsAppExecForTests(
      vi.fn(async (file, args) => {
        if (file === 'systemctl') return { stdout: 'active\n' };
        if (args.includes('chats')) {
          return envelope([
            {
              jid: 'pinned@s.whatsapp.net',
              name: 'Pinned old',
              kind: 'dm',
              pinned: true,
              last_message_ts: '2026-01-01T00:00:00Z',
            },
            {
              jid: 'empty@g.us',
              name: 'Metadata only',
              kind: 'group',
              last_message_ts: '0001-01-01T00:00:00Z',
            },
            {
              jid: 'new@s.whatsapp.net',
              name: 'Newest',
              kind: 'dm',
              last_message_ts: '2026-09-09T12:00:00Z',
            },
            {
              jid: 'middle@s.whatsapp.net',
              name: 'Middle',
              kind: 'dm',
              last_message_ts: '2026-09-09T11:00:00Z',
            },
          ]);
        }
        return envelope({ fts: true, messages: [] });
      }),
    );

    const result = JSON.parse(
      await whatsappRead({ recentChatCount: 2, messagesPerChat: 1 }),
    );
    expect(result.chats.map((chat: { name: string }) => chat.name)).toEqual([
      'Newest',
      'Middle',
    ]);
  });
});

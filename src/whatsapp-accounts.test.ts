import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  file: `/tmp/nanoclaw-whatsapp-accounts-${process.pid}-${Math.random()}.json`,
}));
vi.mock('./config.js', async (original) => ({
  ...(await original<typeof import('./config.js')>()),
  WHATSAPP_ACCOUNTS_FILE: fixture.file,
}));
import { WHATSAPP_STORE_DIR } from './config.js';
import { resolveWhatsAppAccount } from './whatsapp-accounts.js';
import {
  _setWhatsAppExecForTests,
  downloadWhatsAppMedia,
  whatsappListChats,
  whatsappRead,
  whatsappSearch,
  whatsappStatus,
} from './whatsapp-workspace.js';

const target = { chatId: 'parents@g.us', name: 'Parents original name' };
const config = {
  accounts: {
    pt: {
      storeDir: '/tmp/pt-store',
      syncService: 'wacli-pt-sync.service',
      aliases: { turma: target, 'parents group': target },
    },
  },
};
const envelope = (data: unknown) => ({
  stdout: JSON.stringify({ success: true, data }),
});
beforeEach(() => fs.writeFileSync(fixture.file, JSON.stringify(config)));
afterEach(() => {
  fs.rmSync(fixture.file, { force: true });
  _setWhatsAppExecForTests();
});

describe('WhatsApp accounts', () => {
  it('keeps the original default and rejects unknown accounts before executing', async () => {
    const exec = vi.fn();
    _setWhatsAppExecForTests(exec);
    expect(resolveWhatsAppAccount({}).storeDir).toBe(WHATSAPP_STORE_DIR);
    await expect(
      whatsappRead({ account: '../../other', recentChatCount: 1 }),
    ).rejects.toThrow('unknown account');
    expect(exec).not.toHaveBeenCalled();
    fs.rmSync(fixture.file);
    expect(resolveWhatsAppAccount({}).id).toBe('default');
  });

  it('rejects unsafe config paths and ambiguous account aliases', () => {
    fs.writeFileSync(
      fixture.file,
      JSON.stringify({
        accounts: { pt: { ...config.accounts.pt, storeDir: 'relative' } },
      }),
    );
    expect(() => resolveWhatsAppAccount({})).toThrow('invalid account');
    fs.writeFileSync(
      fixture.file,
      JSON.stringify({
        accounts: {
          ...config.accounts,
          other: { ...config.accounts.pt, storeDir: '/tmp/other' },
        },
      }),
    );
    expect(() => resolveWhatsAppAccount({ chatNames: ['Turma'] })).toThrow(
      'multiple accounts',
    );
    expect(
      resolveWhatsAppAccount({ account: 'pt', chatNames: ['Turma'] }).id,
    ).toBe('pt');
  });

  it('reads aliases by stable ID and keeps concurrent requests in separate stores', async () => {
    const exec = vi.fn(async (file: string, args: string[]) => {
      if (file === 'systemctl') return { stdout: 'active' };
      if (args.includes('chats'))
        return envelope([
          {
            jid: 'original@g.us',
            name: 'Original',
            last_message_ts: '2026-09-16T10:00:00Z',
          },
        ]);
      return envelope({
        messages: [
          {
            MsgID: '1',
            Timestamp: '2026-09-16T10:00:00Z',
            Text: args[1],
            ChatName: 'Renamed parents',
          },
        ],
      });
    });
    _setWhatsAppExecForTests(exec);
    const [pt, original] = await Promise.all([
      whatsappRead({ chatNames: [' TuRmA '], messagesPerChat: 1 }),
      whatsappRead({ recentChatCount: 1 }),
    ]).then((rows) => rows.map((row) => JSON.parse(row)));
    expect(pt.account).toBe('pt');
    expect(pt.chats[0]).toMatchObject({
      chatId: 'parents@g.us',
      coverage: 'ready',
      limitReached: true,
    });
    expect(pt.chats[0].messages[0].text).toBe('/tmp/pt-store');
    expect(original.account).toBe('default');
    expect(original.chats[0].messages[0].text).toBe(WHATSAPP_STORE_DIR);
    expect(
      exec.mock.calls.some(
        ([file, args]) =>
          file === 'systemctl' && args.includes('wacli-pt-sync.service'),
      ),
    ).toBe(true);
    const ptCalls = exec.mock.calls.filter(
      ([file, args]) => file !== 'systemctl' && args[1] === '/tmp/pt-store',
    );
    expect(ptCalls).toHaveLength(1);
    expect(ptCalls[0][1]).toContain('parents@g.us');
    expect(ptCalls[0][1]).toContain('--read-only');
  });

  it('routes status, discovery, search, and both media operations through pt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-media-'));
    const exec = vi.fn(async (file: string, args: string[]) => {
      if (file === 'systemctl') return { stdout: 'active' };
      if (args.includes('doctor'))
        return envelope({ authenticated: true, store: {} });
      if (args.includes('chats')) return envelope([]);
      if (args.includes('search')) return envelope({ fts: true, messages: [] });
      if (args.includes('show'))
        return envelope({ MediaType: 'audio', MimeType: 'audio/ogg' });
      if (args.includes('download'))
        fs.writeFileSync(args[args.indexOf('--output') + 1], 'audio fixture');
      return envelope({});
    });
    _setWhatsAppExecForTests(exec);
    try {
      const status = JSON.parse(await whatsappStatus({ account: 'pt' }));
      expect(status).toMatchObject({ account: 'pt', serviceState: 'running' });
      expect(
        status.availableAccounts.map((a: { account: string }) => a.account),
      ).toEqual(['default', 'pt']);
      expect(
        JSON.parse(await whatsappListChats({ account: 'pt' })).account,
      ).toBe('pt');
      expect(
        JSON.parse(
          await whatsappSearch({ chatId: 'parents group', query: 'photos' }),
        ).account,
      ).toBe('pt');
      const media = await downloadWhatsAppMedia(
        { account: 'pt', chatId: 'parents@g.us', messageId: '1' },
        dir,
      );
      expect(media.publicResult).toMatchObject({
        account: 'pt',
        chatId: 'parents@g.us',
        bytes: 13,
      });
      for (const [file, args] of exec.mock.calls) {
        if (file === 'systemctl')
          expect(args).toContain('wacli-pt-sync.service');
        else
          expect(args.slice(0, 4)).toEqual([
            '--store',
            '/tmp/pt-store',
            '--read-only',
            '--json',
          ]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

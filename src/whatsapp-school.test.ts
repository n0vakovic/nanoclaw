import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  dir: `/tmp/nanoclaw-school-${process.pid}-${Math.random()}`,
}));
vi.mock('./config.js', async (original) => ({
  ...(await original<typeof import('./config.js')>()),
  DATA_DIR: fixture.dir,
  WHATSAPP_ACCOUNTS_FILE: `${fixture.dir}/accounts.json`,
  WHATSAPP_STORE_DIR: '/tmp/default-school-store',
}));
import {
  _setSchoolDependenciesForTests,
  completeSchoolSummary,
  prepareSchoolSummary,
  schoolSummaryCoverage,
} from './whatsapp-school.js';
const messages = [
  {
    senderId: undefined,
    senderName: undefined,
    media: undefined,
    chatId: '111@g.us',
    messageId: 'm1',
    timestamp: new Date().toISOString(),
    fromMe: false,
    text: 'Bring photos',
    edited: false,
    revoked: false,
  },
  {
    senderId: undefined,
    senderName: undefined,
    media: undefined,
    chatId: '111@g.us',
    messageId: 'm2',
    timestamp: new Date().toISOString(),
    fromMe: false,
    text: 'Thank you',
    edited: false,
    revoked: false,
  },
];
const read = vi.fn(async () => messages);
const send = vi.fn(async () => ({ messageId: 'sent-1' }));
const prepare = async (mode = 'daily') =>
  JSON.parse(await prepareSchoolSummary({ mode }));
beforeEach(() => {
  fs.mkdirSync(fixture.dir, { recursive: true });
  fs.writeFileSync(
    `${fixture.dir}/accounts.json`,
    JSON.stringify({
      accounts: {
        pt: { storeDir: '/tmp/pt-school-store', syncService: 'pt.service' },
      },
    }),
  );
  fs.writeFileSync(
    `${fixture.dir}/whatsapp-school.json`,
    JSON.stringify({
      source: { account: 'pt', chatId: '111@g.us', name: 'Parents' },
      destination: { account: 'default', chatId: '222@g.us', name: 'Family' },
      startAt: '2026-01-01T00:00:00Z',
      language: 'Serbian Latin',
      timezone: 'Europe/Lisbon',
    }),
  );
  read.mockClear();
  send.mockReset();
  send.mockResolvedValue({ messageId: 'sent-1' });
  _setSchoolDependenciesForTests({ read, send });
});
afterEach(() => {
  _setSchoolDependenciesForTests();
  fs.rmSync(fixture.dir, { recursive: true, force: true });
});

describe('school summaries', () => {
  it('formats coverage in Lisbon time with daylight saving', () => {
    expect(
      schoolSummaryCoverage(
        [{ timestamp: '2026-09-16T18:40:30Z' }],
        'Europe/Lisbon',
      ),
    ).toContain('19:40');
    expect(
      schoolSummaryCoverage(
        [{ timestamp: '2026-01-16T18:40:30Z' }],
        'Europe/Lisbon',
      ),
    ).toContain('18:40');
  });
  it('reads pt, sends only to the fixed default destination, and deduplicates completion', async () => {
    const snapshot = await prepare();
    expect(read).toHaveBeenCalledWith('pt', '111@g.us', expect.any(String));
    const params = {
      snapshotId: snapshot.snapshotId,
      text: 'Poneti fotografije.',
      messageIds: ['m1'],
      account: 'pt',
      chatId: 'evil@g.us',
    };
    const result = JSON.parse(await completeSchoolSummary(params));
    expect(result.status).toBe('sent');
    expect(send).toHaveBeenCalledExactlyOnceWith(
      '/tmp/default-school-store',
      '222@g.us',
      expect.stringContaining('🤖 Školski pregled\n\nPoneti fotografije.'),
    );
    expect(JSON.parse(await completeSchoolSummary(params))).toEqual(result);
    expect(send).toHaveBeenCalledTimes(1);
    expect((await prepare()).messages).toEqual([]);
    expect(
      (await prepare('urgent')).messages.map(
        (m: { messageId: string }) => m.messageId,
      ),
    ).toEqual(['m2']);
    expect((await prepare('on_demand')).messages).toHaveLength(2);
  });

  it('always sends an empty scheduled digest and deduplicates its completion', async () => {
    const first = await prepare();
    await completeSchoolSummary({
      snapshotId: first.snapshotId,
      text: 'Novosti.',
      messageIds: ['m1', 'm2'],
    });
    const empty = await prepare();
    expect(empty.messages).toHaveLength(0);
    send.mockClear();
    const result = JSON.parse(
      await completeSchoolSummary({ snapshotId: empty.snapshotId }),
    );
    expect(result.status).toBe('sent');
    expect(send).toHaveBeenCalledExactlyOnceWith(
      '/tmp/default-school-store',
      '222@g.us',
      expect.stringContaining('Nema novih poruka od prethodnog pregleda.'),
    );
    await completeSchoolSummary({ snapshotId: empty.snapshotId });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects silently skipping routine messages in a normal scheduled summary', async () => {
    const snapshot = await prepare();
    await expect(
      completeSchoolSummary({ snapshotId: snapshot.snapshotId }),
    ).rejects.toThrow('cannot be skipped');
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps routine news for daily review after a quiet hourly check', async () => {
    const snapshot = await prepare('urgent');
    expect(
      JSON.parse(
        await completeSchoolSummary({ snapshotId: snapshot.snapshotId }),
      ).status,
    ).toBe('skipped');
    expect(send).not.toHaveBeenCalled();
    expect((await prepare('urgent')).messages).toEqual([]);
    expect((await prepare()).messages).toHaveLength(2);
  });

  it('blocks unsupported IDs and stale snapshots, including competing sends', async () => {
    const daily = await prepare();
    const urgent = await prepare('urgent');
    await expect(
      completeSchoolSummary({
        snapshotId: daily.snapshotId,
        text: 'Hi',
        messageIds: ['unknown'],
      }),
    ).rejects.toThrow('snapshot');
    await completeSchoolSummary({
      snapshotId: urgent.snapshotId,
      text: 'Važno',
      messageIds: ['m1'],
    });
    await expect(
      completeSchoolSummary({
        snapshotId: daily.snapshotId,
        text: 'Hi',
        messageIds: ['m1'],
      }),
    ).rejects.toThrow('already covered');
    expect(send).toHaveBeenCalledTimes(1);
    const fresh = await prepare();
    await expect(
      completeSchoolSummary({ snapshotId: daily.snapshotId }),
    ).rejects.toThrow('expired');
    expect(fresh.messages).toHaveLength(1);
  });

  it('does not retry after uncertain delivery, including after a process restart', async () => {
    const snapshot = await prepare();
    send.mockRejectedValue(new Error('timeout after submission'));
    await expect(
      completeSchoolSummary({
        snapshotId: snapshot.snapshotId,
        text: 'Test',
        messageIds: ['m1'],
      }),
    ).rejects.toThrow('timeout');
    _setSchoolDependenciesForTests({ read, send });
    await expect(prepare()).rejects.toThrow('uncertain');
    await expect(
      completeSchoolSummary({
        snapshotId: snapshot.snapshotId,
        text: 'Test',
        messageIds: ['m1'],
      }),
    ).rejects.toThrow('uncertain');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

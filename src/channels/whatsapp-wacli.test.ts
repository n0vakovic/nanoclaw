import fs from 'fs';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  dir: `/tmp/ras-listener-${process.pid}-${Math.random()}`,
}));
vi.mock('../config.js', async (original) => ({
  ...(await original<typeof import('../config.js')>()),
  DATA_DIR: fixture.dir,
}));
import { isRasTrigger, WacliConversationChannel } from './whatsapp-wacli.js';
const config = {
  account: 'default',
  chatId: '123@g.us',
  name: 'Family',
  groupFolder: 'whatsapp_school',
  emailSourceGroup: 'telegram_main',
};
beforeEach(() => fs.mkdirSync(fixture.dir, { recursive: true }));
afterEach(() => fs.rmSync(fixture.dir, { recursive: true, force: true }));
it('recognizes typed triggers without responding to its own replies', () => {
  expect(isRasTrigger('@Ras hello', true)).toBe(true);
  expect(isRasTrigger('hey @ras hello', false)).toBe(true);
  expect(isRasTrigger('@Rascal hello', false)).toBe(false);
  expect(isRasTrigger('hello', false)).toBe(false);
  expect(isRasTrigger('🤖 Ras\n\nTry @Ras', true)).toBe(false);
});
it('processes both spouses, checkpoints ignored messages, and never replays processed triggers', async () => {
  const messages = [
    {
      MsgID: 'a',
      Timestamp: new Date().toISOString(),
      Text: '@Ras hi',
      FromMe: true,
    },
    {
      MsgID: 'b',
      Timestamp: new Date().toISOString(),
      Text: '@Ras zdravo',
      FromMe: false,
    },
    {
      MsgID: 'c',
      Timestamp: new Date().toISOString(),
      Text: 'ordinary conversation',
    },
    {
      MsgID: 'd',
      Timestamp: new Date().toISOString(),
      Text: '🤖 Ras\n@Ras echo',
      FromMe: true,
    },
  ];
  const run = vi.fn(async () => ({
    stdout: JSON.stringify({ success: true, data: { messages } }),
  }));
  const opts = {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({
      '123@g.us': {
        name: 'Family',
        folder: 'whatsapp_school',
        trigger: '@Ras',
        added_at: 'today',
      },
    }),
  };
  const channel = new WacliConversationChannel(config, opts, run);
  await channel.poll();
  await channel.poll();
  expect(opts.onMessage).toHaveBeenCalledTimes(2);
  const restored = new WacliConversationChannel(config, opts, run);
  await restored.poll();
  expect(opts.onMessage).toHaveBeenCalledTimes(2);
});
it('restricts replies to the configured group and blocks retry after ambiguous failure', async () => {
  const run = vi.fn(async () => {
    throw new Error('timeout');
  });
  const opts = {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  };
  const channel = new WacliConversationChannel(config, opts, run);
  await expect(channel.sendMessage('other@g.us', 'Hi')).rejects.toThrow(
    'only reply',
  );
  expect(run).not.toHaveBeenCalled();
  await expect(channel.sendMessage('123@g.us', 'Hi')).rejects.toThrow(
    'timeout',
  );
  await expect(channel.sendMessage('123@g.us', 'Hi')).rejects.toThrow(
    'uncertain',
  );
  expect(run).toHaveBeenCalledTimes(1);
});

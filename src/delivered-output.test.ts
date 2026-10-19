import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  getChatOutputs,
  getMessagesSince,
  getNewMessages,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import {
  deliveredOutputContext,
  readChatOutputs,
  sendDeliveredOutput,
} from './delivered-output.js';
import { Channel } from './types.js';

beforeEach(() => {
  _initTestDatabase();
  storeChatMetadata('chat-a', '2026-10-19T00:00:00.000Z');
  storeChatMetadata('chat-b', '2026-10-19T00:00:00.000Z');
});

function channel(send = vi.fn().mockResolvedValue(undefined)): Channel {
  return {
    sendMessage: vi.fn(),
    sendMessageStrict: send,
  } as unknown as Channel;
}

describe('delivered assistant output context', () => {
  it('persists the full confirmed delivery without triggering or advancing inbound polling', async () => {
    const text = 'Scheduled digest: ' + 'full detail '.repeat(3000);
    const sender = channel();
    await sendDeliveredOutput(sender, 'chat-a', text, 'Scheduled task');
    expect(sender.sendMessageStrict).toHaveBeenCalledWith('chat-a', text);
    expect(getChatOutputs('chat-a')[0].content).toBe(text);
    expect(getMessagesSince('chat-a', '', 'Andy')).toEqual([]);
    expect(getNewMessages(['chat-a'], '', 'Andy')).toEqual({
      messages: [],
      newTimestamp: '',
    });
    const prompt = deliveredOutputContext('chat-a');
    expect(prompt).toContain('Scheduled task');
    expect(prompt).toContain('truncated="true"');
    expect(prompt.length).toBeLessThan(25000);
    const id = getChatOutputs('chat-a')[0].id;
    expect(
      JSON.parse(readChatOutputs('chat-a', { id })).outputs[0].content,
    ).toBe(text);
  });

  it('does not record failed or foreign deliveries and scopes retrieval to the originating chat', async () => {
    await expect(
      sendDeliveredOutput(
        channel(vi.fn().mockRejectedValue(new Error('offline'))),
        'chat-a',
        'failed',
        'Scheduled task',
      ),
    ).rejects.toThrow('offline');
    expect(getChatOutputs('chat-a')).toEqual([]);
    expect(deliveredOutputContext('chat-a')).toBe('');
    await sendDeliveredOutput(
      channel(),
      'chat-b',
      'private output',
      'Background job',
    );
    const id = getChatOutputs('chat-b')[0].id;
    expect(JSON.parse(readChatOutputs('chat-a', { id })).outputs).toEqual([]);
    expect(deliveredOutputContext('chat-a')).not.toContain('private output');
    expect(() => readChatOutputs(undefined)).toThrow('Missing source chat');
  });

  it('orders, limits, paginates and escapes historical evidence without exposing inbound messages', () => {
    for (let i = 1; i <= 7; i++) {
      storeMessage({
        id: `out-${i}`,
        chat_jid: 'chat-a',
        sender: 'assistant',
        sender_name: 'Scheduled task',
        content: `<result>${i}</result>`,
        timestamp: `2026-10-19T00:00:0${i}.000Z`,
        is_from_me: true,
        is_bot_message: true,
      });
    }
    storeMessage({
      id: 'user',
      chat_jid: 'chat-a',
      sender: 'user',
      sender_name: 'User',
      content: 'User request',
      timestamp: '2026-10-19T00:00:08.000Z',
      is_from_me: false,
    });
    const recent = JSON.parse(readChatOutputs('chat-a', { limit: 2 })).outputs;
    expect(recent.map((m: { id: string }) => m.id)).toEqual(['out-7', 'out-6']);
    const older = JSON.parse(
      readChatOutputs('chat-a', { before: recent[1].timestamp, limit: 2 }),
    ).outputs;
    expect(older.map((m: { id: string }) => m.id)).toEqual(['out-5', 'out-4']);
    const context = deliveredOutputContext('chat-a');
    expect(context).toContain('&lt;result&gt;7&lt;/result&gt;');
    expect(context).not.toContain('out-2');
    expect(context.indexOf('out-3')).toBeLessThan(context.indexOf('out-7'));
    expect(context).not.toContain('User request');
  });

  it('rejects malformed retrieval parameters', () => {
    expect(() => readChatOutputs('chat-a', { before: 'invalid' })).toThrow(
      'ISO timestamp',
    );
    expect(() => readChatOutputs('chat-a', { limit: 10000 })).toThrow(
      '1 to 50',
    );
    expect(() => readChatOutputs('chat-a', { id: 1 })).toThrow('string');
  });
});

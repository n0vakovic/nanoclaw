import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, storeChatMetadata, storeMessage } from './db.js';
import { ActionContext, dispatchAction } from './host-actions.js';

const context: ActionContext = {
  sourceGroup: 'group-a',
  sourceChatJid: 'chat-a',
  groupIpcDir: '/tmp/output-action-test-ipc',
};

beforeEach(() => {
  _initTestDatabase();
  for (const jid of ['chat-a', 'chat-b']) {
    storeChatMetadata(jid, '2026-10-19T00:00:00.000Z');
    storeMessage({
      id: `output-${jid}`,
      chat_jid: jid,
      sender: 'assistant',
      sender_name: 'Scheduled task',
      content: `Private full output for ${jid}`,
      timestamp: '2026-10-19T00:00:01.000Z',
      is_from_me: true,
      is_bot_message: true,
    });
  }
});

describe('readChatOutputs host action', () => {
  it('dispatches the registered action using the authenticated source chat', async () => {
    const result = await dispatchAction(
      { action: 'readChatOutputs', requestId: 'read-own-output' },
      context,
    );
    expect(result.ok).toBe(true);
    expect(result.requestId).toBe('read-own-output');
    expect(JSON.parse(result.output).outputs).toEqual([
      expect.objectContaining({
        id: 'output-chat-a',
        content: 'Private full output for chat-a',
      }),
    ]);
    expect(result.output).not.toContain('Private full output for chat-b');
  });

  it.each([false, true])(
    'ignores forged target-chat parameters even when isMain=%s',
    async (isMain) => {
      const result = await dispatchAction(
        {
          action: 'readChatOutputs',
          requestId: 'attempt-cross-chat-read',
          params: {
            id: 'output-chat-b',
            chatJid: 'chat-b',
            sourceChatJid: 'chat-b',
            sourceGroup: 'group-b',
          },
        },
        { ...context, isMain },
      );
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.output).outputs).toEqual([]);
    },
  );

  it('fails closed without source chat context, including forged request context', async () => {
    const request = {
      action: 'readChatOutputs',
      requestId: 'missing-source-chat',
      params: { sourceChatJid: 'chat-b', chatJid: 'chat-b' },
    };
    for (const ctx of [undefined, { ...context, sourceChatJid: undefined }]) {
      const result = await dispatchAction(request, ctx);
      expect(result.ok).toBe(false);
      expect(result.output).toBe('Missing source chat context');
    }
  });
});

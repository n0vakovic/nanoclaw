import { describe, expect, it } from 'vitest';
import {
  normalizeTelegramRichMessage,
  telegramRichMessageText,
} from './telegram-rich-message.js';

describe('Telegram rich message ingestion', () => {
  it('preserves paragraphs, nested lists and inline links in transcript messages', () => {
    const message = {
      rich_message: {
        blocks: [
          { type: 'paragraph', text: 'if you read this reply with:' },
          { type: 'paragraph', text: '42: {summary}' },
          {
            type: 'list',
            items: [
              {
                label: '•',
                blocks: [{ type: 'paragraph', text: 'milan = green' }],
              },
              {
                label: '•',
                blocks: [{ type: 'paragraph', text: 'abbie = dark' }],
              },
            ],
          },
          {
            type: 'paragraph',
            text: [
              'concert: ',
              { type: 'url', text: 'AWARE', url: 'https://example.com' },
            ],
          },
          { type: 'paragraph', text: '[18:02] milan: have fun ahahha' },
        ],
      },
    };
    normalizeTelegramRichMessage(message);
    expect(message).toHaveProperty(
      'text',
      'if you read this reply with:\n42: {summary}\n• milan = green\n• abbie = dark\nconcert: AWARE\n[18:02] milan: have fun ahahha',
    );
  });

  it('normalizes quoted rich messages without replacing ordinary text', () => {
    const message = {
      text: 'read this?',
      reply_to_message: {
        rich_message: {
          blocks: [{ type: 'paragraph', text: 'original transcript' }],
        },
      },
    };
    normalizeTelegramRichMessage(message);
    expect(message.text).toBe('read this?');
    expect(message.reply_to_message).toHaveProperty(
      'text',
      'original transcript',
    );
  });

  it('makes unsupported rich content visible rather than dropping the update', () => {
    const message = {
      rich_message: { blocks: [{ type: 'photo', photo: {} }] },
    };
    normalizeTelegramRichMessage(message);
    expect(message).toHaveProperty(
      'text',
      expect.stringContaining('no readable text'),
    );
    expect(telegramRichMessageText(null)).toBe('');
  });
});

it('routes a rich-only Telegram update through the real grammY text filter', async () => {
  const { Bot } = await import('grammy');
  const bot = new Bot('123:test', {
    botInfo: {
      id: 123,
      is_bot: true,
      first_name: 'Test',
      username: 'test_bot',
      can_join_groups: true,
      can_read_all_group_messages: true,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
      has_topics_enabled: false,
      allows_users_to_create_topics: false,
    },
  });
  let delivered: string | undefined;
  bot.use(async (ctx, next) => {
    normalizeTelegramRichMessage(ctx.message);
    await next();
  });
  bot.on('message:text', (ctx) => {
    delivered = ctx.message.text;
  });
  await bot.handleUpdate({
    update_id: 1,
    message: {
      message_id: 6394,
      date: 1793309630,
      chat: { id: -5581516299, type: 'group', title: 'Relo' },
      from: { id: 1, is_bot: false, first_name: 'Milan' },
      rich_message: {
        blocks: [{ type: 'paragraph', text: '42: recovered transcript' }],
      },
    },
  } as unknown as Parameters<typeof bot.handleUpdate>[0]);
  expect(delivered).toBe('42: recovered transcript');
});

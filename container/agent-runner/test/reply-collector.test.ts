import { describe, expect, it } from 'vitest';

import { ReplyCollector } from '../src/reply-collector.js';

const assistant = (uuid: string, text: string) => ({
  type: 'assistant',
  uuid,
  parent_tool_use_id: null,
  message: { content: [{ type: 'text', text }] },
});

describe('agent reply delivery', () => {
  it('preserves the answer before a tool call and sends the final acknowledgement once', () => {
    const replies = new ReplyCollector();
    replies.add(assistant('estimate', 'My estimate: 1075 kcal.'));
    replies.add({
      type: 'assistant',
      uuid: 'edit',
      message: {
        content: [{ type: 'tool_use', name: 'Edit' }],
      },
    });
    replies.add({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'Saved' }] },
    });
    replies.add(assistant('done', 'Logged.'));
    expect(replies.finish('Logged.')).toBe(
      'My estimate: 1075 kcal.\n\nLogged.',
    );
    replies.add(assistant('next', 'Next reply.'));
    expect(replies.finish('Next reply.')).toBe('Next reply.');
  });

  it('ignores thinking, tools, subagent messages, and repeated SDK messages', () => {
    const replies = new ReplyCollector();
    replies.add({
      type: 'assistant',
      uuid: 'thinking',
      message: {
        content: [{ type: 'thinking', thinking: 'private reasoning' }],
      },
    });
    replies.add({
      ...assistant('child', 'Worker output'),
      parent_tool_use_id: 'task-1',
    });
    replies.add(assistant('answer', 'Visible answer'));
    replies.add(assistant('answer', 'Visible answer'));
    expect(replies.finish()).toBe('Visible answer');
    expect(replies.finish()).toBeNull();
  });

  it('uses result-only output and preserves a distinct final result', () => {
    const replies = new ReplyCollector();
    expect(replies.finish('Final answer')).toBe('Final answer');
    replies.add(assistant('intro', 'First part'));
    expect(replies.finish('Second part')).toBe('First part\n\nSecond part');
  });
});

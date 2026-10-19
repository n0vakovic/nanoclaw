import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceMode, VoiceReplyGuard } from '../src/voice-mode.js';

const dirs: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-voice-'));
  dirs.push(dir);
  const mode = new VoiceMode(dir, 'tg:123');
  return { dir, mode, guard: new VoiceReplyGuard(mode, 'query') };
}
const voicePrompt =
  '<messages><message modality="voice" sender="Milan">hello</message></messages>';
const textPrompt =
  '<messages><message sender="Milan">hello</message></messages>';
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('persistent voice mode', () => {
  it('starts inactive, prints exact markers, survives sessions, and isolates chats', () => {
    const { dir, mode } = fixture();
    expect(mode.isActive()).toBe(false);
    expect(mode.setActive(true)).toContain('[VOICE MODE ACTIVE]');
    expect(new VoiceMode(dir, 'tg:123').isActive()).toBe(true);
    expect(new VoiceMode(dir, 'tg:other').isActive()).toBe(false);
    expect(mode.setActive(false)).toBe('[VOICE MODE DEACTIVATED]');
    expect(new VoiceMode(dir, 'tg:123').isActive()).toBe(false);
  });

  it('reminds text-only voice responses once, leaving mode active if TTS fails', () => {
    const { mode, guard } = fixture();
    mode.setActive(true);
    expect(guard.acceptPrompt(voicePrompt)).toContain('[VOICE MODE ACTIVE]');
    expect(guard.stop()).toEqual({
      decision: 'block',
      reason: expect.stringContaining('only sent text'),
    });
    expect(guard.stop()).toEqual({});
    expect(mode.isActive()).toBe(true);
    guard.acceptPrompt(voicePrompt);
    expect(guard.stop().decision).toBe('block');
  });

  it('permits voice plus text only after confirmed delivery in this query', () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const { mode, guard } = fixture();
    mode.setActive(true);
    guard.acceptPrompt(voicePrompt);
    fs.mkdirSync(path.dirname(mode.deliveryPath('query')), { recursive: true });
    fs.writeFileSync(
      mode.deliveryPath('different-query'),
      JSON.stringify({ deliveredAt: 10_001 }),
    );
    expect(guard.reminder()).toBeDefined();
    fs.writeFileSync(
      mode.deliveryPath('query'),
      JSON.stringify({ deliveredAt: 9_999 }),
    );
    expect(guard.reminder()).toBeDefined();
    fs.writeFileSync(
      mode.deliveryPath('query'),
      JSON.stringify({ deliveredAt: 10_001 }),
    );
    expect(guard.stop()).toEqual({});
    vi.setSystemTime(20_000);
    guard.acceptPrompt(voicePrompt);
    expect(guard.stop().decision).toBe('block');
  });

  it('allows explicit exit, text inputs, and inactive mode without reminders', () => {
    const { mode, guard } = fixture();
    guard.acceptPrompt(voicePrompt);
    expect(guard.stop()).toEqual({});
    guard.stop();
    mode.setActive(true);
    guard.acceptPrompt(textPrompt);
    expect(guard.stop()).toEqual({});
    guard.acceptPrompt(voicePrompt);
    mode.setActive(false);
    expect(guard.stop()).toEqual({});
  });

  it('keeps a pending voice reply required across an in-flight text follow-up', () => {
    const { mode, guard } = fixture();
    mode.setActive(true);
    guard.acceptPrompt(voicePrompt);
    guard.acceptPrompt(textPrompt);
    expect(guard.stop().decision).toBe('block');
    guard.stop();
    guard.acceptPrompt(textPrompt);
    expect(guard.stop()).toEqual({});
  });

  it('ignores voice markers in quoted historical context', () => {
    const { mode, guard } = fixture();
    mode.setActive(true);
    guard.acceptPrompt(
      '<prior_delivered_outputs>&lt;message modality="voice"&gt;old&lt;/message&gt;</prior_delivered_outputs>' +
        textPrompt,
    );
    expect(guard.stop()).toEqual({});
  });
});

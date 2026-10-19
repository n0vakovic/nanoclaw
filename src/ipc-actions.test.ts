import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _assertValidActionRequest,
  _deliverVoiceWithConfirmation,
  _writeActionResultExclusive,
} from './ipc.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ipc-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('host action IPC envelope', () => {
  it('rejects request IDs that can traverse out of action-results', () => {
    expect(() =>
      _assertValidActionRequest({
        action: 'googleCalendarList',
        requestId: '../../store/messages',
        params: {},
      }),
    ).toThrow('Invalid host action request envelope');
  });

  it('writes a new result exclusively', () => {
    _writeActionResultExclusive(tempDir, 'calendar-123_abc', {
      ok: true,
    });
    expect(
      JSON.parse(
        fs.readFileSync(path.join(tempDir, 'calendar-123_abc.json'), 'utf8'),
      ),
    ).toEqual({ ok: true });
  });

  it('will not follow a pre-created result symlink', () => {
    const target = path.join(tempDir, 'target.txt');
    const resultDir = path.join(tempDir, 'results');
    fs.mkdirSync(resultDir);
    fs.writeFileSync(target, 'unchanged');
    fs.symlinkSync(target, path.join(resultDir, 'calendar-123.json'));

    expect(() =>
      _writeActionResultExclusive(resultDir, 'calendar-123', {
        overwritten: true,
      }),
    ).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('unchanged');
  });
});

describe('voice delivery acknowledgement', () => {
  const voiceScope = '00000000-0000-4000-8000-000000000000';
  it('records a voice reply only after the channel confirms delivery', async () => {
    let release!: () => void;
    const pending = _deliverVoiceWithConfirmation(
      { chatJid: 'tg:123', requestId: 'voice-ok', voiceScope },
      tempDir,
      '/tmp/audio.ogg',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const marker = path.join(tempDir, 'voice-deliveries', voiceScope + '.json');
    expect(fs.existsSync(marker)).toBe(false);
    release();
    await pending;
    expect(
      JSON.parse(fs.readFileSync(marker, 'utf8')).deliveredAt,
    ).toBeGreaterThan(0);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(tempDir, 'action-results/voice-ok.json'),
          'utf8',
        ),
      ).ok,
    ).toBe(true);
  });
  it('reports a channel error without satisfying the voice guard', async () => {
    await expect(
      _deliverVoiceWithConfirmation(
        { chatJid: 'tg:123', requestId: 'voice-failed', voiceScope },
        tempDir,
        '/tmp/audio.ogg',
        async () => {
          throw new Error('network unavailable');
        },
      ),
    ).rejects.toThrow('network unavailable');
    expect(
      fs.existsSync(
        path.join(tempDir, 'voice-deliveries', voiceScope + '.json'),
      ),
    ).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(tempDir, 'action-results/voice-failed.json'),
          'utf8',
        ),
      ),
    ).toEqual({
      ok: false,
      output: expect.stringContaining('network unavailable'),
    });
  });
  it('rejects malformed acknowledgement paths before sending', async () => {
    let sent = false;
    await expect(
      _deliverVoiceWithConfirmation(
        { chatJid: 'tg:123', requestId: '../bad', voiceScope },
        tempDir,
        '/tmp/audio.ogg',
        async () => {
          sent = true;
        },
      ),
    ).rejects.toThrow('Invalid voice delivery request ID');
    expect(sent).toBe(false);
  });
});

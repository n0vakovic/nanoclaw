import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({ ipcDir: '', query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: harness.query }));
vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal<typeof import('fs')>()).default;
  const redirected = { ...actual } as any;
  for (const method of [
    'existsSync',
    'readFileSync',
    'writeFileSync',
    'mkdirSync',
    'readdirSync',
    'unlinkSync',
    'renameSync',
    'rmSync',
  ]) {
    redirected[method] = (...args: any[]) => {
      const translated = args.map((arg: any) =>
        typeof arg === 'string' && arg.startsWith('/workspace/ipc')
          ? harness.ipcDir + arg.slice('/workspace/ipc'.length)
          : arg,
      );
      return (actual[method as keyof typeof actual] as any)(...translated);
    };
  }
  return { default: redirected };
});

import { runQuery } from '../src/index.js';
import { VoiceMode } from '../src/voice-mode.js';

const text = '<messages><message sender="Milan">hello</message></messages>';
const voice =
  '<messages><message modality="voice" sender="Milan">please answer</message></messages>';
const result = (uuid: string) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Reply',
  uuid,
});
const hookInput = {
  session_id: 'session',
  transcript_path: '/tmp/unused',
  cwd: '/workspace/group',
};

beforeEach(() => {
  harness.ipcDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-hook-integration-'),
  );
  fs.mkdirSync(path.join(harness.ipcDir, 'input'));
  harness.query.mockReset();
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(harness.ipcDir, { recursive: true, force: true });
});

const run = (prompt: string) =>
  runQuery(
    prompt,
    undefined,
    '/runner/ipc-mcp-stdio.js',
    {
      prompt,
      chatJid: 'tg:123',
      groupFolder: 'main',
      isMain: true,
    },
    {},
  );

it('wires SDK prompt and Stop hooks across streamed turns, including a queued voice before an earlier result', async () => {
  new VoiceMode(harness.ipcDir, 'tg:123').setActive(true);
  harness.query.mockImplementation(async function* ({ prompt, options }: any) {
    const input = prompt[Symbol.asyncIterator]();
    const submit = options.hooks.UserPromptSubmit[0].hooks[0];
    const stop = options.hooks.Stop[0].hooks[0];
    const first = (await input.next()).value.message.content;
    const context = await submit({
      ...hookInput,
      hook_event_name: 'UserPromptSubmit',
      prompt: first,
    });
    expect(context.hookSpecificOutput.additionalContext).toContain(
      '[VOICE MODE ACTIVE]',
    );
    expect(
      await stop({
        ...hookInput,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      }),
    ).toEqual({});

    // Host queues a new voice prompt while the preceding text turn is ending.
    fs.writeFileSync(
      path.join(harness.ipcDir, 'input/voice.json'),
      JSON.stringify({ type: 'message', text: voice }),
    );
    await vi.advanceTimersByTimeAsync(500);
    const second = (await input.next()).value.message.content;
    expect(second).toBe(voice);
    await submit({
      ...hookInput,
      hook_event_name: 'UserPromptSubmit',
      prompt: second,
    });
    // The SDK may dispatch the next hook before its consumer processes the
    // previous result. Consuming that old result must not clear this voice.
    yield result('first-result');
    expect(
      await stop({
        ...hookInput,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      }),
    ).toEqual({
      decision: 'block',
      reason: expect.stringContaining('send_voice_note'),
    });
    // If the voice service fails, allow completion after the reminder instead of looping.
    expect(
      await stop({
        ...hookInput,
        hook_event_name: 'Stop',
        stop_hook_active: true,
      }),
    ).toEqual({});
    yield result('second-result');

    await submit({
      ...hookInput,
      hook_event_name: 'UserPromptSubmit',
      prompt: text,
    });
    expect(
      await stop({
        ...hookInput,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      }),
    ).toEqual({});
    yield result('third-result');
  });
  await run(text);
  expect(harness.query).toHaveBeenCalledOnce();
  expect(new VoiceMode(harness.ipcDir, 'tg:123').isActive()).toBe(true);
});

it('honors mode entry, confirmed voice delivery, and explicit exit within SDK hook callbacks', async () => {
  const mode = new VoiceMode(harness.ipcDir, 'tg:123');
  harness.query.mockImplementation(async function* ({ prompt, options }: any) {
    const initial = (await prompt[Symbol.asyncIterator]().next()).value.message
      .content;
    const submit = options.hooks.UserPromptSubmit[0].hooks[0];
    const stop = options.hooks.Stop[0].hooks[0];
    const context = await submit({
      ...hookInput,
      hook_event_name: 'UserPromptSubmit',
      prompt: initial,
    });
    expect(context.hookSpecificOutput.additionalContext).toBeUndefined();
    mode.setActive(true); // Equivalent to the explicit MCP enter_voice_mode call.
    const reminder = await stop({
      ...hookInput,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    });
    expect(reminder.reason).toContain('Do not automatically convert');
    const scope = options.mcpServers.nanoclaw.env.NANOCLAW_VOICE_SCOPE;
    fs.mkdirSync(path.dirname(mode.deliveryPath(scope)), { recursive: true });
    fs.writeFileSync(
      mode.deliveryPath(scope),
      JSON.stringify({ deliveredAt: Date.now() }),
    );
    expect(
      await stop({
        ...hookInput,
        hook_event_name: 'Stop',
        stop_hook_active: true,
      }),
    ).toEqual({});
    mode.setActive(false);
    expect(
      await stop({
        ...hookInput,
        hook_event_name: 'Stop',
        stop_hook_active: false,
      }),
    ).toEqual({});
    yield result('voice-result');
  });
  await run(voice);
  expect(mode.isActive()).toBe(false);
  expect(fs.readdirSync(path.join(harness.ipcDir, 'voice-deliveries'))).toEqual(
    [],
  );
});

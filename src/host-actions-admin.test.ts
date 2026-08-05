import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const testPaths = vi.hoisted(() => {
  const base = `/tmp/nanoclaw-host-actions-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  return {
    base,
    dataDir: `${base}/data`,
    groupsDir: `${base}/groups`,
    githubAllowlistPath: `${base}/github-allowlist.json`,
  };
});

const transcribeAudioDetailedMock = vi.hoisted(() => vi.fn());
const synthesizeSpeechDetailedMock = vi.hoisted(() => vi.fn());

vi.mock('./config.js', () => ({
  DATA_DIR: testPaths.dataDir,
  GROUPS_DIR: testPaths.groupsDir,
  GITHUB_ALLOWLIST_PATH: testPaths.githubAllowlistPath,
  RETAINED_TRANSCRIPTION_TIMEOUT_MS: 45000,
  TTS_FETCH_TIMEOUT_MS: 30000,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./sync-action.js', () => ({
  runSyncRepos: vi.fn(async () => 'ok'),
}));

vi.mock('./transcription.js', () => ({
  transcribeAudioDetailed: transcribeAudioDetailedMock,
}));

vi.mock('./tts.js', () => ({
  synthesizeSpeechDetailed: synthesizeSpeechDetailedMock,
}));

import { dispatchAction } from './host-actions.js';
import { writeIntergroupInboxItem } from './intergroup-inbox.js';
import { RegisteredGroup } from './types.js';

const mainContext = {
  sourceGroup: 'telegram_main',
  groupIpcDir: '/tmp/ipc',
  isMain: true,
};

beforeEach(() => {
  transcribeAudioDetailedMock.mockReset();
  synthesizeSpeechDetailedMock.mockReset();
  fs.rmSync(testPaths.base, { recursive: true, force: true });
  fs.mkdirSync(path.join(testPaths.groupsDir, 'global'), { recursive: true });
  fs.mkdirSync(path.join(testPaths.groupsDir, 'other-group'), {
    recursive: true,
  });
});

describe('TTS host action', () => {
  it('correlates the host action request and writes generated audio', async () => {
    const groupIpcDir = path.join(testPaths.base, 'ipc', 'telegram_main');
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-eleven-key');
    synthesizeSpeechDetailedMock.mockResolvedValue({
      audio: Buffer.from('mp3 bytes'),
      diagnostic: { classification: 'tts_succeeded' },
    });

    const result = await dispatchAction(
      {
        action: 'ttsSpeak',
        requestId: 'tts-request-1',
        params: { text: 'Hello', voice: 'vlad' },
      },
      { ...mainContext, groupIpcDir },
    );

    expect(result.ok).toBe(true);
    const output = JSON.parse(result.output) as { audioPath: string };
    expect(output.audioPath).toMatch(/^\/workspace\/ipc\/media\/tts-.*\.mp3$/);
    expect(synthesizeSpeechDetailedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'test-eleven-key',
        text: 'Hello',
        voiceId: 'XjdmlV0OFXfXE6Mg2Sb7',
        timeoutMs: 30000,
        context: {
          hostActionRequestId: 'tts-request-1',
          sourceGroup: 'telegram_main',
        },
      }),
    );
    const hostAudioPath = path.join(
      groupIpcDir,
      output.audioPath.replace('/workspace/ipc/', ''),
    );
    expect(fs.readFileSync(hostAudioPath)).toEqual(Buffer.from('mp3 bytes'));
    vi.unstubAllEnvs();
  });
});

describe('audio transcription host action', () => {
  it('transcribes a retained group audio file and preserves it', async () => {
    const groupIpcDir = path.join(testPaths.base, 'ipc', 'telegram_main');
    const mediaDir = path.join(groupIpcDir, 'media');
    const audioPath = path.join(mediaDir, 'voice_3447.oga');
    const metadataPath = path.join(mediaDir, 'voice_3447.json');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(audioPath, Buffer.from('audio bytes'));
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({ status: 'transcription_failed' }),
    );
    transcribeAudioDetailedMock.mockResolvedValue({
      transcript: 'Recovered voice transcript',
      diagnostic: { classification: 'plain_transcription_succeeded' },
    });

    const result = await dispatchAction(
      {
        action: 'transcribeAudio',
        requestId: 'transcribe-1',
        params: { audioPath: '/workspace/ipc/media/voice_3447.oga' },
      },
      {
        sourceGroup: 'telegram_main',
        groupIpcDir,
        isMain: true,
      },
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(result.output).transcript).toBe(
      'Recovered voice transcript',
    );
    expect(transcribeAudioDetailedMock).toHaveBeenCalledWith(
      Buffer.from('audio bytes'),
      'voice_3447.oga',
      {
        timeoutMs: 45000,
        enablePlainFallback: false,
        primaryMode: 'gpt4o_plain_json',
        context: 'retained_host_action',
        audioDurationSeconds: undefined,
      },
    );
    expect(fs.existsSync(audioPath)).toBe(true);
    expect(fs.readFileSync(metadataPath, 'utf-8')).toContain(
      '"status": "transcribed_by_host_action"',
    );
  });

  it('rejects paths outside the requesting group media directory', async () => {
    const groupIpcDir = path.join(testPaths.base, 'ipc', 'telegram_main');
    fs.mkdirSync(groupIpcDir, { recursive: true });

    const result = await dispatchAction(
      {
        action: 'transcribeAudio',
        requestId: 'transcribe-2',
        params: { audioPath: '/workspace/ipc/../other/voice.oga' },
      },
      {
        sourceGroup: 'telegram_main',
        groupIpcDir,
        isMain: true,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('escapes group IPC dir');
    expect(transcribeAudioDetailedMock).not.toHaveBeenCalled();
  });

  it('retains the audio when transcription is unavailable', async () => {
    const groupIpcDir = path.join(testPaths.base, 'ipc', 'telegram_main');
    const mediaDir = path.join(groupIpcDir, 'media');
    const audioPath = path.join(mediaDir, 'voice_3447.oga');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(audioPath, Buffer.from('audio bytes'));
    transcribeAudioDetailedMock.mockResolvedValue({
      transcript: null,
      diagnostic: {
        classification: 'transcription_backend_no_response_after_upload',
        attempts: [],
      },
    });

    const result = await dispatchAction(
      {
        action: 'transcribeAudio',
        requestId: 'transcribe-3',
        params: { audioPath: '/workspace/ipc/media/voice_3447.oga' },
      },
      {
        sourceGroup: 'telegram_main',
        groupIpcDir,
        isMain: true,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain(
      'transcription_backend_no_response_after_upload',
    );
    expect(result.output).toContain('retained audio was not deleted');
    expect(fs.existsSync(audioPath)).toBe(true);
  });
});

describe('admin memory host actions', () => {
  it('rejects non-main callers', async () => {
    const result = await dispatchAction(
      {
        action: 'readGlobalMemory',
        requestId: 'req-1',
        params: { file: 'CLAUDE.md' },
      },
      {
        sourceGroup: 'other-group',
        groupIpcDir: '/tmp/ipc',
        isMain: false,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('restricted to the main group');
  });

  it('writes group memory with a backup and audit record', async () => {
    const memoryPath = path.join(
      testPaths.groupsDir,
      'other-group',
      'CLAUDE.md',
    );
    fs.writeFileSync(memoryPath, 'old memory\n');

    const result = await dispatchAction(
      {
        action: 'writeGroupMemory',
        requestId: 'req-2',
        params: {
          group: 'other-group',
          file: 'CLAUDE.md',
          content: 'new memory\n',
        },
      },
      mainContext,
    );

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(memoryPath, 'utf-8')).toBe('new memory\n');
    expect(
      fs.readdirSync(path.join(testPaths.dataDir, 'admin-memory-backups')),
    ).toHaveLength(1);
    expect(
      fs.readFileSync(
        path.join(testPaths.dataDir, 'admin-memory-audit.jsonl'),
        'utf-8',
      ),
    ).toContain('"action":"writeGroupMemory"');
  });

  it('updates trigger mode through the registered group updater', async () => {
    const groups: Record<string, RegisteredGroup> = {
      'other@g.us': {
        name: 'Other',
        folder: 'other-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: true,
      },
    };

    const result = await dispatchAction(
      {
        action: 'setGroupTriggerMode',
        requestId: 'req-3',
        params: {
          group: 'other-group',
          requiresTrigger: false,
        },
      },
      {
        ...mainContext,
        registeredGroups: () => groups,
        updateRegisteredGroup: (jid, group) => {
          groups[jid] = group;
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(groups['other@g.us'].requiresTrigger).toBe(false);
  });

  it('reads a compact tail of a registered group session', async () => {
    const sessionDir = path.join(
      testPaths.dataDir,
      'sessions',
      'other-group',
      '.claude',
      'projects',
      '-workspace-group',
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'session-1.jsonl'),
      [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-05-29T10:00:00.000Z',
          message: { role: 'user', content: 'hello from main' },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-05-29T10:00:01.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'hello back' },
              { type: 'tool_use', name: 'read_file' },
            ],
          },
        }),
      ].join('\n') + '\n',
    );

    const result = await dispatchAction(
      {
        action: 'readGroupSessionTail',
        requestId: 'req-4',
        params: {
          group: 'other-group',
          limit: 2,
        },
      },
      {
        ...mainContext,
        registeredGroups: () => ({
          'other@g.us': {
            name: 'Other',
            folder: 'other-group',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        }),
      },
    );

    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.group).toBe('other-group');
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[1].text).toBe('hello back');
    expect(parsed.entries[1].toolNames).toEqual(['read_file']);
  });

  it('lists and acknowledges intergroup inbox items', async () => {
    writeIntergroupInboxItem({
      id: 'surface-test-1',
      sourceGroup: 'other-group',
      sourceName: 'Other',
      sourceJid: 'other@g.us',
      mainGroup: 'telegram_main',
      mainJid: 'main@g.us',
      subject: 'Check this',
      body: 'Something worth noticing',
      priority: 'high',
      createdAt: '2026-05-29T12:00:00.000Z',
    });

    const listed = await dispatchAction(
      {
        action: 'listIntergroupInbox',
        requestId: 'req-5',
        params: {},
      },
      mainContext,
    );

    expect(listed.ok).toBe(true);
    const listPayload = JSON.parse(listed.output);
    expect(listPayload.items).toHaveLength(1);
    expect(listPayload.items[0].subject).toBe('Check this');

    const acked = await dispatchAction(
      {
        action: 'ackIntergroupInbox',
        requestId: 'req-6',
        params: { id: 'surface-test-1' },
      },
      mainContext,
    );

    expect(acked.ok).toBe(true);
    expect(JSON.parse(acked.output).acknowledgedAt).toBeTruthy();

    const listedAfterAck = await dispatchAction(
      {
        action: 'listIntergroupInbox',
        requestId: 'req-7',
        params: {},
      },
      mainContext,
    );
    expect(JSON.parse(listedAfterAck.output).items).toHaveLength(0);
  });

  it('surfaces to main synchronously from a non-main group', async () => {
    const result = await dispatchAction(
      {
        action: 'surfaceToMain',
        requestId: 'req-8',
        params: {
          surfaceId: 'surface-sync-test',
          subject: 'Sync surface',
          body: 'This should exist before the tool returns',
          priority: 'normal',
        },
      },
      {
        sourceGroup: 'other-group',
        groupIpcDir: '/tmp/ipc-other',
        isMain: false,
        registeredGroups: () => ({
          'main@g.us': {
            name: 'Main',
            folder: 'telegram_main',
            trigger: 'always',
            added_at: '2024-01-01T00:00:00.000Z',
            isMain: true,
          },
          'other@g.us': {
            name: 'Other',
            folder: 'other-group',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        }),
      },
    );

    expect(result.ok).toBe(true);
    const item = JSON.parse(result.output);
    expect(item.id).toBe('surface-sync-test');
    expect(item.sourceGroup).toBe('other-group');
    expect(
      fs.existsSync(
        path.join(
          testPaths.dataDir,
          'ipc',
          'telegram_main',
          'intergroup-inbox',
          'surface-sync-test.json',
        ),
      ),
    ).toBe(true);
  });
});

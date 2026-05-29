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

vi.mock('./config.js', () => ({
  DATA_DIR: testPaths.dataDir,
  GROUPS_DIR: testPaths.groupsDir,
  GITHUB_ALLOWLIST_PATH: testPaths.githubAllowlistPath,
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

import { dispatchAction } from './host-actions.js';
import { RegisteredGroup } from './types.js';

const mainContext = {
  sourceGroup: 'telegram_main',
  groupIpcDir: '/tmp/ipc',
  isMain: true,
};

beforeEach(() => {
  fs.rmSync(testPaths.base, { recursive: true, force: true });
  fs.mkdirSync(path.join(testPaths.groupsDir, 'global'), { recursive: true });
  fs.mkdirSync(path.join(testPaths.groupsDir, 'other-group'), {
    recursive: true,
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
});

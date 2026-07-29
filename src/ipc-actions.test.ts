import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _assertValidActionRequest,
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

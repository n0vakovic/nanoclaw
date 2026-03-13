/**
 * Host Action Registry for NanoClaw
 *
 * Container agents request named actions by writing JSON to their IPC actions/
 * directory. The host (this module) executes the registered handler and writes
 * the result back to action-results/. The registry is the sole security boundary:
 * if it's not here, it cannot be triggered.
 */
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CODING_DIR } from './config.js';
import { logger } from './logger.js';

const execAsync = promisify(exec);

export interface ActionRequest {
  action: string;
  requestId: string;
}

export interface ActionResult {
  requestId: string;
  ok: boolean;
  output: string;
}

type ActionHandler = () => Promise<string>;

const ACTION_REGISTRY: Record<string, ActionHandler> = {
  /**
   * git pull every repo in ~/coding, excluding _third_party.
   * Skips directories that aren't git repos.
   */
  syncRepos: async () => {
    let entries: string[];
    try {
      entries = fs.readdirSync(CODING_DIR);
    } catch (err) {
      throw new Error(`Cannot read ${CODING_DIR}: ${err instanceof Error ? err.message : String(err)}`);
    }

    const repos = entries.filter((f) => {
      if (f === '_third_party') return false;
      const fullPath = path.join(CODING_DIR, f);
      try {
        return (
          fs.statSync(fullPath).isDirectory() &&
          fs.existsSync(path.join(fullPath, '.git'))
        );
      } catch {
        return false;
      }
    });

    const results: string[] = [];
    for (const repo of repos) {
      try {
        const { stdout, stderr } = await execAsync('git pull', {
          cwd: path.join(CODING_DIR, repo),
        });
        const output = (stdout || stderr).trim() || 'ok';
        results.push(`${repo}: ${output}`);
        logger.info({ repo, output }, 'syncRepos: git pull');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push(`${repo}: ERROR - ${msg}`);
        logger.warn({ repo, err }, 'syncRepos: git pull failed');
      }
    }

    return results.length > 0
      ? results.join('\n')
      : `No git repos found in ${CODING_DIR}`;
  },
};

export async function dispatchAction(request: ActionRequest): Promise<ActionResult> {
  const handler = ACTION_REGISTRY[request.action];
  if (!handler) {
    return {
      requestId: request.requestId,
      ok: false,
      output: `Unknown action: "${request.action}". Available: ${Object.keys(ACTION_REGISTRY).join(', ')}`,
    };
  }

  try {
    const output = await handler();
    return { requestId: request.requestId, ok: true, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { requestId: request.requestId, ok: false, output: msg };
  }
}

/**
 * syncRepos host action — bidirectional sync between ~/coding and ~/damrassbot/sync.
 *
 * Inbound:  git pull every repo under ~/coding (skipping _third_party).
 * Outbound: route any files staged in ~/damrassbot/sync/<repo>/<path> into the
 *           matching repo, commit each file, push once per repo, then delete
 *           the staged source. Three verbs picked by location + suffix:
 *             - fragments/        → SNAPSHOT (date-stamped immutable file)
 *             - *.inflow.md       → APPEND (with provenance header; creates if missing)
 *             - *.md (otherwise)  → WRITE (place file; overwrites if exists)
 *
 * Optional regex filter scopes a run to source paths matching the regex (path
 * is the full relative path under SYNC_DIR, including the repo segment).
 */
import { exec, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CODING_DIR, SYNC_DIR } from './config.js';
import { logger } from './logger.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export type SyncVerb = 'snapshot' | 'append' | 'write';

export interface SyncFile {
  sourceAbs: string;
  repo: string;
  relPath: string; // path inside the repo
  fullRelPath: string; // <repo>/<relPath>, used for filter matching
  mtimeMs: number;
}

/**
 * Pure: pick the verb and target path for a source file given its relPath
 * inside its repo.
 *
 * `nowDate` (YYYYMMDD) is used as the default snapshot date when the source
 * has none. `nowTs` (YYYYMMDDTHHMMSS) is used to escalate on collisions.
 * `exists` reports whether a candidate target already exists in the repo —
 * supplied by the caller so this function stays pure and testable.
 *
 * Throws if asked to write `fragments/<base>.md` directly (would clobber the
 * canonical fragments file).
 */
export function pickVerb(
  relPath: string,
  nowDate: string,
  nowTs: string,
  exists: (targetRelPath: string) => boolean,
): { verb: SyncVerb; targetRelPath: string } {
  const segments = relPath.split('/');
  const fileName = segments[segments.length - 1];

  if (segments[0] === 'fragments') {
    // fragments/<base>.inflow.md → fragments/<base>/<base>.<nowDate>.md,
    // escalate to <base>.<nowTs>.md on collision.
    if (segments.length === 2 && fileName.endsWith('.inflow.md')) {
      const base = fileName.replace(/\.inflow\.md$/, '');
      const dated = `fragments/${base}/${base}.${nowDate}.md`;
      if (!exists(dated)) {
        return { verb: 'snapshot', targetRelPath: dated };
      }
      return {
        verb: 'snapshot',
        targetRelPath: `fragments/${base}/${base}.${nowTs}.md`,
      };
    }

    // fragments/<base>.md (plain, top of fragments) — would overwrite the
    // canonical fragments file. Refuse.
    if (segments.length === 2) {
      throw new Error(
        `snapshot: refusing to write ${relPath} — would overwrite the canonical fragments file. Use fragments/<base>.inflow.md (auto-dated) or fragments/<base>/<name>.md (variant snapshot).`,
      );
    }

    // fragments/<base>/<...>.inflow.md — strip .inflow; on collision append
    // the HHMMSS portion of nowTs before .md to disambiguate.
    if (fileName.endsWith('.inflow.md')) {
      const stripped = fileName.replace(/\.inflow\.md$/, '.md');
      const target = [...segments.slice(0, -1), stripped].join('/');
      if (!exists(target)) {
        return { verb: 'snapshot', targetRelPath: target };
      }
      const hms = nowTs.slice(9); // "HHMMSS" out of "YYYYMMDDTHHMMSS"
      const escalated = target.replace(/\.md$/, `.${hms}.md`);
      return { verb: 'snapshot', targetRelPath: escalated };
    }

    // fragments/<base>/<...>.md — variant snapshot (e.g. *.newsletter.md).
    // Pass through unchanged.
    return { verb: 'snapshot', targetRelPath: relPath };
  }

  if (fileName.endsWith('.inflow.md')) {
    const stripped = fileName.replace(/\.inflow\.md$/, '.md');
    const newSegments = [...segments.slice(0, -1), stripped];
    return { verb: 'append', targetRelPath: newSegments.join('/') };
  }

  return { verb: 'write', targetRelPath: relPath };
}

/**
 * Provenance header inserted before the inflow body when appending.
 * The leading newline ensures separation from existing content.
 */
export function inflowHeader(relSource: string, nowIso: string): string {
  return `\n\n---\n<!-- inflow from DamRassBot · ${nowIso} · ${relSource} -->\n`;
}

/* ----------------------- internal helpers ----------------------- */

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Recursively walk SYNC_DIR, returning every regular file found.
 * Skips hidden entries (anything starting with '.') at any depth so stray
 * .DS_Store / editor swap files don't get synced.
 */
function walkSyncFiles(syncRoot: string): SyncFile[] {
  if (!fs.existsSync(syncRoot)) return [];

  const out: SyncFile[] = [];

  function walk(dirAbs: string, segments: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue; // skip hidden
      const childAbs = path.join(dirAbs, entry.name);
      const childSegments = [...segments, entry.name];
      if (entry.isDirectory()) {
        walk(childAbs, childSegments);
      } else if (entry.isFile()) {
        if (childSegments.length < 2) continue; // top-level file under sync/ (no repo segment)
        const repo = childSegments[0];
        const relPath = childSegments.slice(1).join('/');
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(childAbs).mtimeMs;
        } catch {
          // unreadable — skip
          continue;
        }
        out.push({
          sourceAbs: childAbs,
          repo,
          relPath,
          fullRelPath: childSegments.join('/'),
          mtimeMs,
        });
      }
    }
  }

  walk(syncRoot, []);
  return out;
}

function listGitRepos(codingDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(codingDir);
  } catch (err) {
    throw new Error(`Cannot read ${codingDir}: ${errMsg(err)}`);
  }
  return entries.filter((f) => {
    if (f === '_third_party') return false;
    const fullPath = path.join(codingDir, f);
    try {
      return (
        fs.statSync(fullPath).isDirectory() &&
        fs.existsSync(path.join(fullPath, '.git'))
      );
    } catch {
      return false;
    }
  });
}

async function applyVerb(
  verb: SyncVerb,
  sourceContent: string,
  targetAbs: string,
  header: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
  if (verb === 'append') {
    if (fs.existsSync(targetAbs)) {
      fs.appendFileSync(targetAbs, header + sourceContent);
    } else {
      // Create from inflow: include header so provenance is recorded even on first write.
      fs.writeFileSync(targetAbs, header.replace(/^\n+/, '') + sourceContent);
    }
  } else {
    // write or snapshot — both place the file.
    fs.writeFileSync(targetAbs, sourceContent);
  }
}

async function isDirty(cwd: string): Promise<boolean> {
  const { stdout } = await execAsync('git status --porcelain', { cwd });
  return stdout.trim().length > 0;
}

/* ----------------------- public entry ----------------------- */

export async function runSyncRepos(
  params?: Record<string, unknown>,
): Promise<string> {
  // Validate filter regex up front so we fail before doing any IO.
  let filterRe: RegExp | null = null;
  const rawFilter = params?.filter;
  if (typeof rawFilter === 'string' && rawFilter.length > 0) {
    try {
      filterRe = new RegExp(rawFilter);
    } catch (err) {
      throw new Error(
        `syncRepos: invalid filter regex "${rawFilter}": ${errMsg(err)}`,
      );
    }
  } else if (rawFilter !== undefined && typeof rawFilter !== 'string') {
    throw new Error('syncRepos: params.filter must be a string');
  }

  const now = new Date();
  const nowIso = now.toISOString();
  // YYYYMMDD and YYYYMMDDTHHMMSS from ISO YYYY-MM-DDTHH:MM:SS.sssZ
  const nowDate = nowIso.slice(0, 4) + nowIso.slice(5, 7) + nowIso.slice(8, 10);
  const nowTs =
    nowDate +
    'T' +
    nowIso.slice(11, 13) +
    nowIso.slice(14, 16) +
    nowIso.slice(17, 19);

  const repos = listGitRepos(CODING_DIR);

  // Discover and group staged files by repo, applying filter.
  const allStaged = walkSyncFiles(SYNC_DIR);
  const filtered = filterRe
    ? allStaged.filter((f) => filterRe!.test(f.fullRelPath))
    : allStaged;

  if (filterRe && filtered.length === 0) {
    return `syncRepos: filter '${rawFilter}' matched no staged files in ${SYNC_DIR}`;
  }

  const stagedByRepo = new Map<string, SyncFile[]>();
  const stagedForUnknownRepos: SyncFile[] = [];
  for (const f of filtered) {
    if (!repos.includes(f.repo)) {
      stagedForUnknownRepos.push(f);
      continue;
    }
    const arr = stagedByRepo.get(f.repo) ?? [];
    arr.push(f);
    stagedByRepo.set(f.repo, arr);
  }

  const results: string[] = [];

  // When a filter is set we only touch repos that actually have matches —
  // skip the global pull-all-repos pass to keep the run a true scoped no-op.
  const reposToProcess = filterRe
    ? repos.filter((r) => stagedByRepo.has(r))
    : repos;

  for (const repo of reposToProcess) {
    const cwd = path.join(CODING_DIR, repo);
    const repoLines: string[] = [];
    const stagedForRepo = (stagedByRepo.get(repo) ?? []).sort(
      (a, b) => a.mtimeMs - b.mtimeMs,
    );

    if (stagedForRepo.length > 0) {
      let dirty = false;
      try {
        dirty = await isDirty(cwd);
      } catch (err) {
        results.push(`${repo}: status ERROR - ${errMsg(err)}`);
        logger.warn({ repo, err }, 'syncRepos: git status failed');
        continue;
      }
      if (dirty) {
        results.push(
          `${repo}: SKIP (dirty working tree, ${stagedForRepo.length} staged file(s) deferred)`,
        );
        continue;
      }
    }

    // Pull
    try {
      const { stdout, stderr } = await execAsync(
        'git pull --rebase --autostash',
        { cwd, timeout: 60000 },
      );
      const output = (stdout || stderr).trim() || 'ok';
      repoLines.push(`pull: ${output}`);
      logger.info({ repo, output }, 'syncRepos: git pull');
    } catch (err) {
      results.push(`${repo}: pull ERROR - ${errMsg(err)}`);
      logger.warn({ repo, err }, 'syncRepos: git pull failed');
      continue;
    }

    // Flush staged files
    const committedSources: string[] = [];
    for (const f of stagedForRepo) {
      try {
        const { verb, targetRelPath } = pickVerb(
          f.relPath,
          nowDate,
          nowTs,
          (rel) => fs.existsSync(path.join(cwd, rel)),
        );
        const targetAbs = path.join(cwd, targetRelPath);
        const sourceContent = fs.readFileSync(f.sourceAbs, 'utf-8');
        const header = verb === 'append' ? inflowHeader(f.relPath, nowIso) : '';
        await applyVerb(verb, sourceContent, targetAbs, header);
        await execFileAsync('git', ['add', '--', targetRelPath], { cwd });
        await execFileAsync(
          'git',
          ['commit', '-m', `damrassbot sync: ${verb} ${targetRelPath}`],
          { cwd },
        );
        committedSources.push(f.sourceAbs);
        repoLines.push(`✓ ${verb} → ${targetRelPath}`);
        logger.info(
          { repo, verb, target: targetRelPath, source: f.fullRelPath },
          'syncRepos: committed',
        );
      } catch (err) {
        repoLines.push(`✗ ${f.relPath}: ${errMsg(err)}`);
        logger.warn(
          { repo, file: f.fullRelPath, err },
          'syncRepos: file flush failed',
        );
        break; // stop further commits in this repo per design
      }
    }

    // Push
    if (committedSources.length > 0) {
      try {
        await execAsync('git push', { cwd, timeout: 60000 });
        repoLines.push(`pushed ${committedSources.length} commit(s)`);
        for (const src of committedSources) {
          try {
            fs.unlinkSync(src);
          } catch (err) {
            logger.warn(
              { src, err },
              'syncRepos: failed to delete source after push',
            );
          }
        }
      } catch (err) {
        repoLines.push(`push ERROR - ${errMsg(err)} (sources kept for retry)`);
        logger.warn({ repo, err }, 'syncRepos: git push failed');
      }
    }

    results.push(`${repo}:\n  ${repoLines.join('\n  ')}`);
  }

  // Flag staged files for repos we couldn't recognize.
  if (stagedForUnknownRepos.length > 0) {
    const unknownRepos = [
      ...new Set(stagedForUnknownRepos.map((f) => f.repo)),
    ].sort();
    results.push(
      `Unknown repo(s) in sync/ (files left in place): ${unknownRepos.join(', ')}`,
    );
  }

  // CoachEx upstream mirror sync — only when running unfiltered (matches
  // the previous behavior; a scoped run shouldn't trigger broad mirror work).
  if (!filterRe) {
    const coachexRepo = 'CoachEx-Tennis-private';
    const syncScript = path.join(
      CODING_DIR,
      coachexRepo,
      '.milan/tools/sync_from_upstream.sh',
    );
    if (repos.includes(coachexRepo) && fs.existsSync(syncScript)) {
      try {
        const { stdout, stderr } = await execAsync(
          `bash .milan/tools/sync_from_upstream.sh --filter "milan/" --allow-dirty`,
          { cwd: path.join(CODING_DIR, coachexRepo), timeout: 120000 },
        );
        const output = (stdout || stderr).trim() || 'ok';
        results.push(`${coachexRepo} (upstream sync): ${output}`);
        logger.info(
          { repo: coachexRepo, output },
          'syncRepos: upstream mirror sync',
        );
      } catch (err) {
        results.push(`${coachexRepo} (upstream sync): ERROR - ${errMsg(err)}`);
        logger.warn(
          { repo: coachexRepo, err },
          'syncRepos: upstream mirror sync failed',
        );
      }
    }
  }

  return results.length > 0
    ? results.join('\n\n')
    : `No git repos found in ${CODING_DIR}`;
}

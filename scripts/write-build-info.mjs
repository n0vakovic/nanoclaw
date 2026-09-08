import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const identity = {
  sha: git('rev-parse', 'HEAD'),
  branch: git('branch', '--show-current') || 'detached',
  builtAt: new Date().toISOString(),
  dirty: git('status', '--porcelain').length > 0,
};
fs.writeFileSync(
  'dist/build-info.json',
  `${JSON.stringify(identity, null, 2)}\n`,
);
console.log(
  `Build: ${identity.sha.slice(0, 12)} (${identity.branch}${identity.dirty ? ', dirty' : ''})`,
);

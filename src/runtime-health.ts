import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export async function checkDocker(): Promise<void> {
  await run('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeout: 5000,
    maxBuffer: 64000,
  });
}

/** Bounded, asynchronous reconciliation before accepting new work after startup. */
export async function reconcileContainers(): Promise<void> {
  const names = async () => {
    const result = await run(
      'docker',
      ['ps', '--filter', 'name=nanoclaw-', '--format', '{{.Names}}'],
      { timeout: 5000, maxBuffer: 64000 },
    );
    return result.stdout
      .trim()
      .split('\n')
      .filter((n) => /^nanoclaw-[A-Za-z0-9_.-]+$/.test(n));
  };
  const orphans = await names();
  await Promise.allSettled(
    orphans.map((name) =>
      run('docker', ['stop', '--time', '5', name], {
        timeout: 10000,
        maxBuffer: 64000,
      }),
    ),
  );
  if ((await names()).length)
    throw new Error('Previous NanoClaw containers have not stopped');
}

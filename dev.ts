import { spawn } from 'node:child_process';
import { join } from 'node:path';

const root = import.meta.dirname;
const commands: [string, string[]][] = [
  [
    process.execPath,
    [
      join(root, 'node_modules/typescript/bin/tsc'),
      '--watch',
      '--preserveWatchOutput',
      '-p',
      'packages/sdk/tsconfig.build.json',
    ],
  ],
  ['npm', ['run', 'dev', '--workspace', 'apps/web']],
  ['npm', ['run', 'dev', '--workspace', 'apps/api']],
];

// Each child leads its own process group, so a signal to the group also reaches what npm and
// its shell start beneath it, which a signal to npm alone does not.
const children = commands.map(([command, args]) =>
  spawn(command, args, { cwd: root, stdio: 'inherit', detached: true }),
);

function stopAll(signal: NodeJS.Signals): void {
  for (const { pid } of children) {
    if (pid === undefined) continue;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      // The group of a child that has exited with everything beneath it no longer exists.
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }
}

for (const child of children) {
  child.on('exit', (code) => {
    process.exitCode ??= code ?? 1;
    stopAll('SIGTERM');
  });
  child.on('error', (error) => {
    process.exitCode ??= 1;
    stopAll('SIGTERM');
    console.error(error);
  });
}
process.on('SIGINT', () => {
  stopAll('SIGINT');
});
process.on('SIGTERM', () => {
  stopAll('SIGTERM');
});

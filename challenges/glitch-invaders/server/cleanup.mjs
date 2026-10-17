/**
 * Cleanup: stop the page server and remove the attempt's files. Safe to run twice, after a failed
 * setup, or with nothing set up at all. It exits 0 in every one of those cases.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolveStatePaths } from './paths.mjs';
import { clearWorkspacePath } from './workspace-file.mjs';

/** How long the server gets to stop on SIGTERM before it is killed. */
const GRACE_MS = 3_000;

/** Whether a process with `pid` exists. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Whether `pid` is still our page server, so a recycled pid is never killed by mistake. When `ps`
 * itself is unavailable the pid file is trusted: a leaked server is worse than a stray signal.
 */
function isPageServer(pid) {
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return command.includes('server/serve.mjs');
  } catch (error) {
    return error.status !== 1;
  }
}

/** Pause for `milliseconds`. */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Stop the server recorded in the pid file, if it is still running. */
export async function stopServer(paths) {
  let pid;
  try {
    pid = Number((await readFile(paths.pidFile, 'utf8')).trim());
  } catch {
    return;
  }
  if (!Number.isInteger(pid) || pid <= 1 || !isAlive(pid) || !isPageServer(pid)) {
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + GRACE_MS;
  while (isAlive(pid) && Date.now() < deadline) {
    await sleep(50);
  }
  if (isAlive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      return;
    }
  }
}

/** Stop the server and remove every file the attempt created. */
export async function runCleanup(paths) {
  await stopServer(paths);
  await clearWorkspacePath(paths.stateDir);
  await clearWorkspacePath(paths.progressFile);
}

if (import.meta.main) {
  runCleanup(resolveStatePaths(process.env, process.cwd())).then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`cleanup: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}

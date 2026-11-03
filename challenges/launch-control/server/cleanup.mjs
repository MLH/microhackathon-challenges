/**
 * Cleanup: stop the page server, remove this session's individual target from the booker's
 * config, and remove the attempt's files. Safe to run twice, after a failed setup, after a crash
 * in a fresh process, or with nothing set up at all: a session with no target is left alone. The
 * LaunchDarkly call runs under a deadline, so cleanup stays within its 30 s cap.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { LaunchDarklyApi } from './launchdarkly-api.mjs';
import { PACKAGE_DIR, resolveStatePaths } from './paths.mjs';
import { readRuntimeConfig } from './runtime-config.mjs';
import { API_TOKEN_VARIABLE, decideMode, launchDarklyOrigins } from './settings.mjs';
import { clearWorkspacePath, readWorkspaceFile } from './workspace-file.mjs';
import { sleep } from './http.mjs';

/** How long the server gets to stop on SIGTERM before it is killed. */
const GRACE_MS = 3_000;

/** The longest cleanup waits for LaunchDarkly, well inside the hook's 30 s cap. */
const TARGET_REMOVAL_DEADLINE_MS = 20_000;

/** The most a pid file holds: a pid and a newline. */
const PID_FILE_MAX_BYTES = 32;

/** The page server's entry point, which a live pid must be running. */
const SERVE_SCRIPT = path.join(PACKAGE_DIR, 'server', 'serve.mjs');

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
 * Whether `pid` is still this package's page server, so a recycled pid is never killed by mistake.
 * When `ps` itself is unavailable the pid file is trusted: a leaked server is worse than a stray
 * signal.
 */
function isPageServer(pid) {
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return command.includes(SERVE_SCRIPT);
  } catch (error) {
    return error.status !== 1;
  }
}

/**
 * Stop the server recorded in the pid file, if it is still running. A pid file that is a symlink or
 * anything but a lone regular file is never read, so a planted one cannot point elsewhere.
 */
export async function stopServer(paths) {
  let pid;
  try {
    pid = Number(((await readWorkspaceFile(paths.pidFile, PID_FILE_MAX_BYTES)) ?? '').trim());
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

/**
 * Where this session's target lives: from the runtime config setup wrote, or, when setup never
 * got that far, from the session id and the settings in `env`.
 *
 * @returns {Promise<{ sessionKey: string, launchDarkly: object } | null>} `null` when the session
 *   ran in demo mode, whose stand-in goes away with the page server, or has no key to remove.
 */
async function liveTarget(paths, env) {
  let runtimeConfig = null;
  try {
    runtimeConfig = await readRuntimeConfig(paths.runtimeConfigFile);
  } catch {
    // A crash can leave the file half-written; the session id and settings in env still find
    // the target, and cleanup must remove it either way.
    runtimeConfig = null;
  }
  if (runtimeConfig !== null) {
    return runtimeConfig.mode === 'live' ? runtimeConfig : null;
  }

  const sessionKey = env.BOOTHSTRAP_SESSION_ID ?? '';
  const decision = await decideMode(env, PACKAGE_DIR);
  if (sessionKey === '' || decision.mode !== 'live') {
    return null;
  }
  const origins = launchDarklyOrigins('live', 0, env);

  return { sessionKey, launchDarkly: { ...decision.settings, apiOrigin: origins.api } };
}

/**
 * Remove this session's individual target, if it ran live and has one.
 *
 * @throws {Error} when LaunchDarkly refuses, fails, or misses the deadline.
 */
async function removeSessionTarget(paths, env) {
  const target = await liveTarget(paths, env);
  if (target === null) {
    return;
  }

  const api = new LaunchDarklyApi({
    origin: target.launchDarkly.apiOrigin,
    token: env[API_TOKEN_VARIABLE] ?? '',
    projectKey: target.launchDarkly.projectKey,
    environmentKey: target.launchDarkly.environmentKey,
    configKey: target.launchDarkly.configKey,
  });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('LaunchDarkly did not answer in time')), TARGET_REMOVAL_DEADLINE_MS);
  });
  try {
    await Promise.race([api.removeSession(target.sessionKey), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stop the server, remove the session's target, and remove every file the attempt created. The
 * files go even when LaunchDarkly fails, and the failure is then rethrown.
 */
export async function runCleanup(paths, env) {
  await stopServer(paths);
  let failure = null;
  try {
    await removeSessionTarget(paths, env);
  } catch (error) {
    failure = error;
  }
  await clearWorkspacePath(paths.stateDir);
  await clearWorkspacePath(paths.stateFile);
  await clearWorkspacePath(paths.itineraryFile);
  if (failure !== null) {
    throw failure;
  }
}

if (import.meta.main) {
  runCleanup(resolveStatePaths(process.env, process.cwd()), process.env).then(
    () => process.exit(0),
    (error) => {
      process.stderr.write(`cleanup: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}

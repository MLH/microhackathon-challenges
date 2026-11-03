/**
 * Setup: prepare a clean attempt and start the page server. It decides live or demo mode, removes
 * any target this session left on the booker's config, writes a fresh runtime config, starts the
 * page server in the background within setup's own process group, and exits 0 only once the page
 * answers and this session's context resolves to v1, so Chrome never opens an unready page.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { stopServer } from './cleanup.mjs';
import { LaunchDarklyApi } from './launchdarkly-api.mjs';
import { PACKAGE_DIR, resolveStatePaths } from './paths.mjs';
import { API_TOKEN_VARIABLE, decideMode, GEMINI_KEY_VARIABLE, launchDarklyOrigins } from './settings.mjs';
import { clearWorkspacePath, ensureWorkspaceDirectory, writeWorkspaceFile } from './workspace-file.mjs';

/** How long setup waits for the page server to listen and connect to its config. */
const READY_TIMEOUT_MS = 20_000;

/** The variable that moves the page server off the manifest's port, for tests and side-by-side runs. */
export const PORT_VARIABLE = 'LAUNCH_CONTROL_PORT';

/** The port from the manifest's `start_url`, unless {@link PORT_VARIABLE} overrides it. */
function resolvePort(env) {
  if ((env[PORT_VARIABLE] ?? '') !== '') {
    return Number(env[PORT_VARIABLE]);
  }
  const manifest = JSON.parse(readFileSync(path.join(PACKAGE_DIR, 'challenge.json'), 'utf8'));

  return Number(new URL(manifest.browser.start_url).port);
}

/**
 * The page server's environment: the hook's, without the LaunchDarkly API token, which only the
 * hooks and the MCP tool use.
 */
function serverEnvironment(env) {
  const { [API_TOKEN_VARIABLE]: _, ...rest } = env;

  return rest;
}

/** Start the page server in the background and wait until it is ready. */
function startServer(paths, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(PACKAGE_DIR, 'server', 'serve.mjs'), paths.workspace], {
      env: serverEnvironment(env),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the page server was not ready within ${READY_TIMEOUT_MS} ms`));
    }, READY_TIMEOUT_MS);

    child.once('message', (message) => {
      clearTimeout(timer);
      if (!message.listening) {
        reject(new Error(`the page server could not start: ${message.error}`));

        return;
      }
      child.unref();
      if (child.connected) {
        child.disconnect();
      }
      resolve(child.pid);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('the page server exited during startup'));
    });
  });
}

/**
 * Check that the page answers and that this session gets v1.
 *
 * @throws {Error} naming the variation the session got instead.
 */
async function confirmFirstRung(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(5_000) });
  const state = await response.json();
  if (state.config?.rung !== 1) {
    const got = state.config === null ? 'no config' : state.config.name;
    throw new Error(`this session gets ${got}, not v1; check the config's default rule, or run provision.mjs`);
  }
}

/** Prepare the attempt and start serving. */
export async function runSetup(env, cwd) {
  const paths = resolveStatePaths(env, cwd);
  if ((env[GEMINI_KEY_VARIABLE] ?? '') === '') {
    throw new Error(`${GEMINI_KEY_VARIABLE} is not set; the booker needs it in both modes`);
  }

  await stopServer(paths);
  await ensureWorkspaceDirectory(paths.stateDir);
  await clearWorkspacePath(paths.stateFile);
  await clearWorkspacePath(paths.itineraryFile);
  await clearWorkspacePath(paths.pidFile);

  const { mode, settings, note } = await decideMode(env, PACKAGE_DIR);
  const port = resolvePort(env);
  const origins = launchDarklyOrigins(mode, port, env);
  const sessionKey = (env.BOOTHSTRAP_SESSION_ID ?? '') === '' ? `standalone-${randomUUID()}` : env.BOOTHSTRAP_SESSION_ID;
  if (mode === 'live') {
    const api = new LaunchDarklyApi({ origin: origins.api, token: env[API_TOKEN_VARIABLE], ...settings });
    await api.removeSession(sessionKey);
  }

  const runtimeConfig = {
    attemptId: randomUUID(),
    sessionKey,
    mode,
    pagePort: port,
    launchDarkly: { apiOrigin: origins.api, streamOrigin: origins.stream, ...settings },
  };
  await writeWorkspaceFile(paths.runtimeConfigFile, `${JSON.stringify(runtimeConfig, null, 2)}\n`);

  const serverPid = await startServer(paths, env);
  try {
    await writeWorkspaceFile(paths.pidFile, `${serverPid}\n`);
    await confirmFirstRung(port);
  } catch (error) {
    process.kill(serverPid, 'SIGKILL');
    throw error;
  }

  return { url: `http://127.0.0.1:${port}/`, mode, note, serverPid };
}

if (import.meta.main) {
  runSetup(process.env, process.cwd()).then(
    (result) => {
      process.stdout.write(`Launch Control is ready at ${result.url} (${result.mode} mode)\n`);
      if (result.note !== null) {
        process.stdout.write(`note: ${result.note}\n`);
      }
      process.exit(0);
    },
    (error) => {
      process.stderr.write(`setup: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}

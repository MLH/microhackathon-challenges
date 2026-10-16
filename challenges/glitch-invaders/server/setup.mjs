/**
 * Setup: prepare a clean attempt and start the page server. Deterministic and fast: it resolves
 * live or demo mode, writes a fresh runtime config, serves the prebuilt game in the background,
 * and exits 0 only once the server answers, so Chrome never opens an unready page.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_INACTIVITY_RESET_MS,
  DEFAULT_INACTIVITY_WARNING_MS,
  decideMode,
} from '../shared/runtime-config.mjs';
import { stopServer } from './cleanup.mjs';
import { readLiveSource } from './live-config.mjs';
import { resolveStatePaths } from './paths.mjs';

/** How long setup waits for the page server to listen. */
const READY_TIMEOUT_MS = 10_000;

/** The package directory: where `challenge.json`, `dist/`, and `server/` live. */
const PACKAGE_DIR = path.resolve(import.meta.dirname, '..');

/** The port from the manifest's `start_url`, overridable for tests and parallel stations. */
function resolvePort(env) {
  if (env.GLITCH_PORT !== undefined && env.GLITCH_PORT !== '') {
    return Number(env.GLITCH_PORT);
  }
  const manifest = JSON.parse(readFileSync(path.join(PACKAGE_DIR, 'challenge.json'), 'utf8'));

  return Number(new URL(manifest.browser.start_url).port);
}

/** A duration override from the environment, or the default when unset or out of range. */
function resolveDuration(value, fallback, max) {
  const parsed = Number(value);

  return value !== undefined && Number.isFinite(parsed) && parsed >= 1_000 && parsed <= max
    ? parsed
    : fallback;
}

/** Start the page server in the background and wait for it to listen. */
function startServer(paths, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(PACKAGE_DIR, 'server', 'serve.mjs')], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: {
        ...process.env,
        GLITCH_PORT: String(port),
        GLITCH_DIST_DIR: path.join(PACKAGE_DIR, 'game'),
        GLITCH_PROGRESS_FILE: paths.progressFile,
        GLITCH_RUNTIME_CONFIG_FILE: paths.runtimeConfigFile,
      },
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the page server did not listen within ${READY_TIMEOUT_MS} ms`));
    }, READY_TIMEOUT_MS);

    child.once('message', (message) => {
      clearTimeout(timer);
      if (!message.listening) {
        reject(
          new Error(`the page server could not listen on 127.0.0.1:${port}: ${message.error}`),
        );

        return;
      }
      child.unref();
      if (child.connected) {
        child.disconnect();
      }
      resolve(child.pid ?? 0);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('the page server exited during startup'));
    });
  });
}

/** Prepare the attempt and start serving. */
export async function runSetup(env, cwd) {
  const paths = resolveStatePaths(env, cwd);
  if (!existsSync(path.join(PACKAGE_DIR, 'game', 'index.html'))) {
    throw new Error('the game page is missing: game/index.html was not found');
  }

  await stopServer(paths);
  if (env.GLITCH_PORT === undefined && paths.workspace !== PACKAGE_DIR) {
    await stopServer(resolveStatePaths({}, PACKAGE_DIR));
  }
  await mkdir(paths.stateDir, { recursive: true });
  await rm(paths.progressFile, { force: true });

  const { source, note } = await readLiveSource(env, PACKAGE_DIR);
  const decision = decideMode(source);
  const config = {
    attemptId: randomUUID(),
    mode: decision.sentry === null ? 'demo' : 'live',
    stationId: env.BOOTHSTRAP_STATION_ID?.slice(0, 128) ?? null,
    sessionId: env.BOOTHSTRAP_SESSION_ID?.slice(0, 128) ?? null,
    inactivityWarningMs: resolveDuration(
      env.GLITCH_INACTIVITY_WARNING_MS,
      DEFAULT_INACTIVITY_WARNING_MS,
      3_600_000,
    ),
    inactivityResetMs: resolveDuration(
      env.GLITCH_INACTIVITY_RESET_MS,
      DEFAULT_INACTIVITY_RESET_MS,
      600_000,
    ),
    sentry: decision.sentry,
  };
  await writeFile(paths.runtimeConfigFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const port = resolvePort(env);
  const serverPid = await startServer(paths, port);
  await writeFile(paths.pidFile, `${serverPid}\n`, { mode: 0o600 });

  return {
    url: `http://127.0.0.1:${port}/`,
    mode: config.mode,
    attemptId: config.attemptId,
    demoReason: decision.demoReason ?? note,
    serverPid,
  };
}

if (import.meta.main) {
  runSetup(process.env, process.cwd()).then(
    (result) => {
      process.stdout.write(`Glitch Invaders is ready at ${result.url} (${result.mode} mode)\n`);
      if (result.mode === 'demo' && result.demoReason !== null) {
        process.stdout.write(`note: live mode is off: ${result.demoReason}\n`);
      }
      process.exit(0);
    },
    (error) => {
      process.stderr.write(`setup: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}

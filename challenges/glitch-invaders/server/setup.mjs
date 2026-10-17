/**
 * Setup: prepare a clean attempt and start the page server. Deterministic and fast: it writes a
 * fresh runtime config, serves the game in the background, and exits 0 only once the server
 * answers, so Chrome never opens an unready page.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { stopServer } from './cleanup.mjs';
import { resolveStatePaths } from './paths.mjs';
import {
  clearWorkspacePath,
  ensureWorkspaceDirectory,
  writeWorkspaceFile,
} from './workspace-file.mjs';

/** How long setup waits for the page server to listen. */
const READY_TIMEOUT_MS = 10_000;

/** The package directory: where `challenge.json`, `game/`, and `server/` live. */
const PACKAGE_DIR = path.resolve(import.meta.dirname, '..');

/** The port from the manifest's `start_url`, overridable for tests and parallel stations. */
function resolvePort(env) {
  if (env.GLITCH_PORT !== undefined && env.GLITCH_PORT !== '') {
    return Number(env.GLITCH_PORT);
  }
  const manifest = JSON.parse(readFileSync(path.join(PACKAGE_DIR, 'challenge.json'), 'utf8'));

  return Number(new URL(manifest.browser.start_url).port);
}

/** Start the page server in the background and wait for it to listen. */
function startServer(paths, port) {
  return new Promise((resolve, reject) => {
    const serveArguments = [
      path.join(PACKAGE_DIR, 'server', 'serve.mjs'),
      String(port),
      paths.runtimeConfigFile,
      paths.progressFile,
    ];
    const child = spawn(process.execPath, serveArguments, {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
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
  await ensureWorkspaceDirectory(paths.stateDir);
  await clearWorkspacePath(paths.progressFile);

  const config = { attemptId: randomUUID() };
  await writeWorkspaceFile(paths.runtimeConfigFile, `${JSON.stringify(config, null, 2)}\n`);

  const port = resolvePort(env);
  const serverPid = await startServer(paths, port);
  await writeWorkspaceFile(paths.pidFile, `${serverPid}\n`);

  return {
    url: `http://127.0.0.1:${port}/`,
    attemptId: config.attemptId,
    serverPid,
  };
}

if (import.meta.main) {
  runSetup(process.env, process.cwd()).then(
    (result) => {
      process.stdout.write(`Glitch Invaders is ready at ${result.url}\n`);
      process.exit(0);
    },
    (error) => {
      process.stderr.write(`setup: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}

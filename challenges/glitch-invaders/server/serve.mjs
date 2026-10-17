/**
 * The page server process: `setup` starts it in the background. It listens on loopback, tells
 * setup once it is ready (or why it could not be), and stops on SIGTERM. In live mode it reads
 * `SENTRY_AUTH_TOKEN` from its environment and hands it only to the Sentry API client.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseRuntimeConfig } from '../shared/runtime-config.mjs';
import { fetchLiveEvidence } from './live-evidence.mjs';
import { createPageServer } from './page-server.mjs';
import { SentryApi } from './sentry-api.mjs';
import { SENTRY_TOKEN_VARIABLE } from './sentry-config.mjs';

/** Tell the parent, if there is one, then drop the channel so the parent can exit. */
function report(message) {
  process.send?.(message, () => process.disconnect?.());
}

/** The game directory the server serves, next to this file's `server/`. */
const GAME_DIR = path.resolve(import.meta.dirname, '..', 'game');

/** Read the arguments setup passes: the port, the runtime config file, and the progress file. */
function readArguments(argv) {
  const [portText, runtimeConfigFile, progressFile] = argv;
  if (portText === undefined || runtimeConfigFile === undefined || progressFile === undefined) {
    throw new Error('usage: serve.mjs <port> <runtime config file> <progress file>');
  }

  return { port: Number(portText), runtimeConfigFile, progressFile };
}

/** The live-evidence fetcher for a live config, or `undefined` in demo mode. */
function liveEvidenceFetcher(runtimeConfig, env) {
  if (runtimeConfig.sentry === undefined) {
    return undefined;
  }
  const token = env[SENTRY_TOKEN_VARIABLE] ?? '';
  if (token === '') {
    throw new Error(`live Sentry mode needs ${SENTRY_TOKEN_VARIABLE}`);
  }

  const api = new SentryApi({ ...runtimeConfig.sentry, token });

  return (bug, id, signal) => fetchLiveEvidence(api, bug, id, signal);
}

/** Start serving. */
function main() {
  const { port, runtimeConfigFile, progressFile } = readArguments(process.argv.slice(2));
  const runtimeConfig = parseRuntimeConfig(JSON.parse(readFileSync(runtimeConfigFile, 'utf8')));
  const fetchEvidence = liveEvidenceFetcher(runtimeConfig, process.env);
  const server = createPageServer({
    gameDir: GAME_DIR,
    progressFile,
    runtimeConfig,
    ...(fetchEvidence === undefined ? {} : { fetchEvidence }),
  });

  server.once('error', (error) => {
    report({ listening: false, error: error.message });
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => report({ listening: true }));

  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

try {
  main();
} catch (error) {
  report({ listening: false, error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}

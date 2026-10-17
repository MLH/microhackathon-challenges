/**
 * The page server process: `setup` starts it in the background. It listens on loopback, tells
 * setup once it is ready (or why it could not be), and stops on SIGTERM.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseRuntimeConfig } from '../shared/runtime-config.mjs';
import { createPageServer } from './page-server.mjs';

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

/** Start serving. */
function main() {
  const { port, runtimeConfigFile, progressFile } = readArguments(process.argv.slice(2));
  const runtimeConfig = parseRuntimeConfig(JSON.parse(readFileSync(runtimeConfigFile, 'utf8')));
  const server = createPageServer({ gameDir: GAME_DIR, progressFile, runtimeConfig });

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

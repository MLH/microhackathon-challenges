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

/** Read a required environment variable. */
function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set`);
  }

  return value;
}

/** Start serving. */
function main() {
  const port = Number(requiredEnv('GLITCH_PORT'));
  const runtimeConfig = parseRuntimeConfig(
    JSON.parse(readFileSync(requiredEnv('GLITCH_RUNTIME_CONFIG_FILE'), 'utf8')),
  );
  const server = createPageServer({
    distDir: path.resolve(requiredEnv('GLITCH_DIST_DIR')),
    progressFile: requiredEnv('GLITCH_PROGRESS_FILE'),
    runtimeConfig,
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

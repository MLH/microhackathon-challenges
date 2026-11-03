/**
 * The page server process: `setup` starts it in the background. It listens on loopback, connects
 * to the booker's config (LaunchDarkly live, or its own stand-in in demo mode), tells setup once it
 * is ready or why it could not be, and stops on SIGTERM. It reads the SDK key and the Gemini key
 * from its environment and never the LaunchDarkly API token, which setup leaves out.
 */
import path from 'node:path';
import { BookerConfigSource } from './booker-config.mjs';
import { Booker } from './booker.mjs';
import { GeminiClient } from './gemini.mjs';
import { loadLadder } from './ladder.mjs';
import { createPageServer, writeStateFile } from './page-server.mjs';
import { PACKAGE_DIR, resolveStatePaths } from './paths.mjs';
import { readRuntimeConfig } from './runtime-config.mjs';
import { TravelDeskSession } from './session.mjs';
import {
  GEMINI_KEY_VARIABLE,
  GEMINI_ORIGIN,
  GEMINI_ORIGIN_VARIABLE,
  readLoopbackOrigin,
  SDK_KEY_VARIABLE,
} from './settings.mjs';
import { LaunchDarklyStandIn } from './stand-in.mjs';
import { loadInventory, TravelDesk } from './travel-desk.mjs';

/** The SDK key demo mode sends its stand-in, which checks none. */
const DEMO_SDK_KEY = 'demo-sdk-key';

/** Tell the parent, if there is one, then drop the channel so the parent can exit. */
function report(message) {
  process.send?.(message, () => process.disconnect?.());
}

/** Read the arguments setup passes: the attempt's workspace. */
function readArguments(argv) {
  const [workspace] = argv;
  if (workspace === undefined) {
    throw new Error('usage: serve.mjs <workspace>');
  }

  return { workspace };
}

/** A key from `env`, or a clear error naming the variable. */
function requireKey(env, name) {
  const value = env[name] ?? '';
  if (value === '') {
    throw new Error(`${name} is not set`);
  }

  return value;
}

/** Listen on `port`, resolving once listening and rejecting on a listen error. */
function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** Start serving. */
async function main() {
  const { workspace } = readArguments(process.argv.slice(2));
  const paths = resolveStatePaths({ BOOTHSTRAP_WORKSPACE: workspace }, workspace);
  const runtimeConfig = await readRuntimeConfig(paths.runtimeConfigFile);
  if (runtimeConfig === null) {
    throw new Error('setup wrote no runtime config');
  }
  const env = process.env;
  const ladder = loadLadder(PACKAGE_DIR);
  const { launchDarkly } = runtimeConfig;

  const standIn =
    runtimeConfig.mode === 'demo'
      ? new LaunchDarklyStandIn({ ladder, projectKey: launchDarkly.projectKey, environmentKey: launchDarkly.environmentKey, configKey: launchDarkly.configKey })
      : undefined;
  const session = new TravelDeskSession(runtimeConfig.mode, ladder);
  const gemini = new GeminiClient({
    origin: readLoopbackOrigin(env, GEMINI_ORIGIN_VARIABLE) ?? GEMINI_ORIGIN,
    key: requireKey(env, GEMINI_KEY_VARIABLE),
  });
  const desk = new TravelDesk({ inventory: loadInventory(PACKAGE_DIR), itineraryFile: paths.itineraryFile });
  // In demo mode the SDK streams from the stand-in on this very server, so the server must listen
  // before the SDK connects; until then the page sees no config.
  const configSource = { resolve: async () => null };
  const server = createPageServer({
    pageDir: path.join(PACKAGE_DIR, 'page'),
    configSource,
    booker: new Booker({ gemini, desk }),
    session,
    sessionKey: runtimeConfig.sessionKey,
    stateFile: paths.stateFile,
    ...(standIn === undefined ? {} : { standIn }),
  });

  await listen(server, runtimeConfig.pagePort);
  const source = await BookerConfigSource.connect({
    streamOrigin: launchDarkly.streamOrigin,
    sdkKey: runtimeConfig.mode === 'live' ? requireKey(env, SDK_KEY_VARIABLE) : DEMO_SDK_KEY,
    configKey: launchDarkly.configKey,
    ladder,
  });
  configSource.resolve = (contextKey) => source.resolve(contextKey);

  /** Rewrite the state file for the config the session gets now. */
  const saveState = async () => {
    await writeStateFile(paths.stateFile, session.snapshot(await source.resolve(runtimeConfig.sessionKey)));
  };
  await saveState();
  // The state file only helps a standalone guide follow along; a failed rewrite after a switch
  // must not take the page down, and the next chat message rewrites it anyway.
  source.onChange(() => saveState().catch(() => {}));
  report({ listening: true });

  /** Stop serving and exit, on SIGTERM or SIGINT. */
  const stop = () => {
    standIn?.close();
    server.close(() => process.exit(0));
    server.closeAllConnections();
    // The process exits once the server closes, whether or not the SDK shuts down cleanly.
    source.close().catch(() => {});
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error) => {
  report({ listening: false, error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});

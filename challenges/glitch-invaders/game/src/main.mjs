/** The page entry: read this attempt's configuration, choose live or demo, and start the game. */
import { createDemoRuntimeConfig, parseRuntimeConfig } from '../../shared/runtime-config.mjs';
import { GameApp } from './app/app.mjs';

import { OfflineReporter } from './sentry/offline-reporter.mjs';

import { SentryReporter } from './sentry/sentry-reporter.mjs';
import { HttpProgressStore, MemoryProgressStore } from './session/progress-store.mjs';

/** The release name live events carry, so Sentry groups them with this challenge. */
const RELEASE = 'glitch-invaders-on-call@1';

/** Read `/runtime-config.json`, falling back to demo mode when there is no page server. */
async function loadConfig() {
  try {
    const response = await fetch('/runtime-config.json', { cache: 'no-store' });
    if (response.ok) {
      return { config: parseRuntimeConfig(await response.json()), served: true };
    }
  } catch {
    // No page server, such as under `vite dev`: demo mode below.
  }

  return { config: createDemoRuntimeConfig('local-dev'), served: false };
}

/** Build the live reporter, or fall back to demo mode if Sentry cannot start. */
function chooseReporter(config) {
  if (config.mode === 'live' && config.sentry !== null) {
    try {
      return {
        config,
        reporter: new SentryReporter(config.sentry, {
          attemptId: config.attemptId,
          stationId: config.stationId,
          sessionId: config.sessionId,
          release: RELEASE,
        }),
      };
    } catch {
      return { config: { ...config, mode: 'demo', sentry: null }, reporter: new OfflineReporter() };
    }
  }

  return { config, reporter: new OfflineReporter() };
}

/** Show a plain message when the game cannot start at all. */
function showFatal(error) {
  const message = error instanceof Error ? error.message : String(error);
  document.body.replaceChildren(
    Object.assign(document.createElement('p'), {
      className: 'fatal',
      textContent: `Glitch Invaders could not start: ${message}. Reload this page.`,
    }),
  );
}

/** Start the game. */
async function main() {
  const loaded = await loadConfig();
  const { config, reporter } = chooseReporter(loaded.config);
  const query = new URLSearchParams(window.location.search);
  const seed = Number(query.get('seed'));
  const store = loaded.served
    ? new HttpProgressStore(
        '/api/progress',
        (input, init) => fetch(input, init),
        () => {},
      )
    : new MemoryProgressStore();

  let saved = null;
  try {
    saved = await store.load(config.attemptId);
  } catch {
    saved = null;
  }

  const app = new GameApp(
    {
      config,
      store,
      reporter,
      reload: () => window.location.reload(),
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      ...(Number.isInteger(seed) && query.has('seed') ? { seed } : {}),
    },
    saved,
  );
  app.begin();
}

main().catch(showFatal);

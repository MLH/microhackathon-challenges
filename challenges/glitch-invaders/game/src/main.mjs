/** The page entry: read this attempt's configuration and saved progress, and start the game. */
import { parseRuntimeConfig } from '../../shared/runtime-config.mjs';
import { GameApp } from './app/app.mjs';
import { HttpProgressStore } from './session/progress-store.mjs';

/** Read `/runtime-config.json`, which the page server writes for every attempt. */
async function loadConfig() {
  const response = await fetch('/runtime-config.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`the runtime config failed to load with status ${response.status}`);
  }

  return parseRuntimeConfig(await response.json());
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

/** Keep the failed save visible: the state line would otherwise keep advancing past a stale file. */
function showSaveError() {
  const banner = document.getElementById('save-error');
  if (banner) {
    banner.hidden = false;
  }
}

/** Start the game. */
async function main() {
  const config = await loadConfig();
  const query = new URLSearchParams(window.location.search);
  const seed = Number(query.get('seed'));
  const store = new HttpProgressStore(
    '/api/progress',
    (input, init) => fetch(input, init),
    showSaveError,
  );

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
      reload: () => window.location.reload(),
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      ...(Number.isInteger(seed) && query.has('seed') ? { seed } : {}),
    },
    saved,
  );
  app.begin();
}

main().catch(showFatal);

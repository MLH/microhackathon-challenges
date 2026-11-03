/**
 * Live or demo: live LaunchDarkly mode needs both halves, the public settings and both
 * LaunchDarkly keys in the environment, where the station's vault puts placeholders it swaps for
 * the real keys on the way out. Anything less is demo mode, which runs the same flow against a
 * local stand-in that serves `ladder.json`. The settings come from the environment when an event
 * sets them, else from the package's `launchdarkly.json`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** The package file holding the public LaunchDarkly settings. */
export const SETTINGS_FILE_NAME = 'launchdarkly.json';

/** The variable the vault's `launchdarkly-sdk` service sets; only the page server reads it. */
export const SDK_KEY_VARIABLE = 'LAUNCHDARKLY_SDK_API_KEY';

/** The variable the vault's `launchdarkly-api` service sets; only the hooks and the MCP tool read it. */
export const API_TOKEN_VARIABLE = 'LAUNCHDARKLY_API_AUTH_TOKEN';

/** The variable the vault's `gemini` service sets, and the one Gemini's own tools read. */
export const GEMINI_KEY_VARIABLE = 'GEMINI_API_KEY';

/**
 * Replaces every LaunchDarkly origin with one loopback stand-in, so tests can run live mode
 * offline. Only `http://127.0.0.1` or `http://localhost` is accepted.
 */
export const LAUNCHDARKLY_ORIGIN_VARIABLE = 'LAUNCH_CONTROL_LAUNCHDARKLY_ORIGIN';

/** Replaces Gemini's API origin with a loopback stand-in, under the same rule. */
export const GEMINI_ORIGIN_VARIABLE = 'LAUNCH_CONTROL_GEMINI_ORIGIN';

/** Gemini's API origin. */
export const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';

/** LaunchDarkly's origins: the REST API, and the streaming host the SDK alone needs with events off. */
export const LIVE_ORIGINS = {
  api: 'https://app.launchdarkly.com',
  stream: 'https://stream.launchdarkly.com',
};

/** The path under the page server where demo mode's LaunchDarkly stand-in answers. */
export const DEMO_PATH = '/demo-launchdarkly';

/** The settings demo mode uses against its stand-in. */
export const DEMO_SETTINGS = { projectKey: 'demo', environmentKey: 'demo', configKey: 'travel-booker' };

/** The environment variable for each setting, which an event's config sets over the file. */
const SETTING_VARIABLES = {
  projectKey: 'LAUNCHDARKLY_PROJECT_KEY',
  environmentKey: 'LAUNCHDARKLY_ENVIRONMENT_KEY',
  configKey: 'LAUNCHDARKLY_AI_CONFIG_KEY',
};

/** What a LaunchDarkly key may look like: letters, digits, `.`, `_`, and `-`. */
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,140}$/;

/** Whether `value` is still a `<placeholder>` waiting for MLH's real setting. */
function isPlaceholder(value) {
  return typeof value === 'string' && value.startsWith('<') && value.endsWith('>');
}

/** The value of `name` in `env`, where an empty variable counts as unset. */
function readVariable(env, name) {
  const value = env[name] ?? '';

  return value === '' ? undefined : value;
}

/**
 * Read the package's settings file.
 *
 * @returns {Promise<Record<string, unknown>>} its record, or `{}` when the file is absent.
 * @throws {Error} naming the file when it is not JSON.
 */
async function readSettingsFile(packageDir) {
  let text;
  try {
    text = await readFile(path.join(packageDir, SETTINGS_FILE_NAME), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${SETTINGS_FILE_NAME} is not valid JSON`);
  }
}

/**
 * Read the public LaunchDarkly settings: each from the environment when set, else from the file.
 *
 * @returns {Promise<{ projectKey: string, environmentKey: string, configKey: string } | null>}
 *   `null` when any setting is missing or still a placeholder.
 * @throws {Error} naming the variable or file field whose value is not a valid key.
 */
export async function readSettings(env, packageDir) {
  const file = await readSettingsFile(packageDir);
  const settings = {};
  for (const [setting, variable] of Object.entries(SETTING_VARIABLES)) {
    const fromEnvironment = readVariable(env, variable);
    const value = fromEnvironment ?? file[setting];
    if (value === undefined || isPlaceholder(value)) {
      return null;
    }
    if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
      const source = fromEnvironment === undefined ? `${SETTINGS_FILE_NAME} ${setting}` : variable;
      throw new Error(`${source} is not a valid LaunchDarkly key`);
    }
    settings[setting] = value;
  }

  return settings;
}

/**
 * Read a loopback origin override from `variable`.
 *
 * @returns {string | undefined} the origin, or `undefined` when the variable is unset.
 * @throws {Error} naming the variable when it is not a plain `http` loopback origin.
 */
export function readLoopbackOrigin(env, variable) {
  const value = readVariable(env, variable);
  if (value === undefined) {
    return undefined;
  }

  const url = URL.parse(value);
  const loopback = url?.hostname === '127.0.0.1' || url?.hostname === 'localhost';
  if (url === null || url.protocol !== 'http:' || !loopback || url.href !== `${url.origin}/`) {
    throw new Error(`${variable} must be an http://127.0.0.1 or http://localhost origin`);
  }

  return url.origin;
}

/**
 * Decide the attempt's mode from the settings and `env`.
 *
 * @returns {Promise<{ mode: 'live' | 'demo', settings: { projectKey: string,
 *   environmentKey: string, configKey: string }, note: string | null }>} `note` says why live mode
 *   is off when the settings are ready for it, and is `null` otherwise.
 */
export async function decideMode(env, packageDir) {
  const settings = await readSettings(env, packageDir);
  if (settings === null) {
    return { mode: 'demo', settings: DEMO_SETTINGS, note: null };
  }

  const missing = [SDK_KEY_VARIABLE, API_TOKEN_VARIABLE].filter((name) => readVariable(env, name) === undefined);
  if (missing.length > 0) {
    return {
      mode: 'demo',
      settings: DEMO_SETTINGS,
      note: `live LaunchDarkly mode is off: ${missing.join(' and ')} not set`,
    };
  }

  return { mode: 'live', settings, note: null };
}

/**
 * The LaunchDarkly origins for an attempt: in live mode the real ones, or the loopback override
 * when set; in demo mode the page server's own stand-in.
 */
export function launchDarklyOrigins(mode, pagePort, env) {
  if (mode === 'demo') {
    const standIn = `http://127.0.0.1:${pagePort}${DEMO_PATH}`;

    return { api: standIn, stream: standIn };
  }

  const override = readLoopbackOrigin(env, LAUNCHDARKLY_ORIGIN_VARIABLE);

  return override === undefined ? LIVE_ORIGINS : { api: override, stream: override };
}

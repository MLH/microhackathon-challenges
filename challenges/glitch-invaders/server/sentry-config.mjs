/**
 * Live or demo: live Sentry mode needs both halves, the public settings and `SENTRY_AUTH_TOKEN` in
 * the environment, where the station's vault puts a placeholder it swaps for the real token on the
 * way out. Anything less is demo mode. The settings come from Sentry's own variables when an event
 * sets them, else from the package's `sentry.json`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSentrySettings } from '../shared/runtime-config.mjs';

/** The package file holding the public Sentry settings. */
export const SENTRY_CONFIG_FILE_NAME = 'sentry.json';

/** The variable the vault's `sentry` service sets, and the one Sentry's own tools read. */
export const SENTRY_TOKEN_VARIABLE = 'SENTRY_AUTH_TOKEN';

/** Sentry's own variable for each setting, which an event's config sets over `sentry.json`. */
const SENTRY_SETTING_VARIABLES = {
  dsn: 'SENTRY_DSN',
  org: 'SENTRY_ORG',
  project: 'SENTRY_PROJECT',
  apiUrl: 'SENTRY_URL',
};

/** The settings an event must set together: all of them but the optional API origin. */
const REQUIRED_SETTINGS = ['dsn', 'org', 'project'];

/**
 * Reduce `apiUrl` written with a bare trailing slash, as sentry-cli documents `SENTRY_URL`
 * (`https://sentry.io/`), to its origin; any other value is left for validation to judge.
 */
function trimBareTrailingSlash(apiUrl) {
  const url = URL.parse(apiUrl);
  if (url === null || url.href !== `${url.origin}/`) {
    return apiUrl;
  }

  return url.origin;
}

/** Rewrite a validation message's `sentry.<setting>` into the variable that set it. */
function nameVariableIn(message) {
  return message.replace(
    /sentry\.(\w+)/,
    (field, setting) => SENTRY_SETTING_VARIABLES[setting] ?? field,
  );
}

/** Whether `value` is still a `<placeholder>` waiting for MLH's real setting. */
function isPlaceholder(value) {
  return typeof value === 'string' && value.startsWith('<') && value.endsWith('>');
}

/**
 * Read the package's Sentry settings.
 *
 * @returns {Promise<ReturnType<typeof parseSentrySettings> | null>} the settings, or `null` when
 *   the file is absent or any value is still a placeholder.
 * @throws {Error} naming the file when it is not JSON or a filled-in value is malformed.
 */
export async function readSentryConfig(packageDir) {
  const file = path.join(packageDir, SENTRY_CONFIG_FILE_NAME);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  let record;
  try {
    record = JSON.parse(text);
  } catch {
    throw new Error(`${SENTRY_CONFIG_FILE_NAME} is not valid JSON`);
  }
  if (Object.values(record ?? {}).some(isPlaceholder)) {
    return null;
  }
  try {
    return parseSentrySettings(record);
  } catch (error) {
    throw new Error(`${SENTRY_CONFIG_FILE_NAME}: ${error.message}`);
  }
}

/**
 * Read the Sentry settings an event sets in `env`, where an empty variable counts as unset.
 *
 * @returns {ReturnType<typeof parseSentrySettings> | null} the settings, or `null` when none of
 *   `SENTRY_DSN`, `SENTRY_ORG`, and `SENTRY_PROJECT` is set.
 * @throws {Error} naming the missing variables when only some of those three are set, or the
 *   malformed variable.
 */
function readSentryEnvironment(env) {
  const record = {};
  for (const [setting, variable] of Object.entries(SENTRY_SETTING_VARIABLES)) {
    const value = env[variable] ?? '';
    if (value !== '') {
      record[setting] = value;
    }
  }

  const missing = REQUIRED_SETTINGS.filter((setting) => record[setting] === undefined);
  if (missing.length === REQUIRED_SETTINGS.length) {
    return null;
  }
  if (missing.length > 0) {
    const names = missing.map((setting) => SENTRY_SETTING_VARIABLES[setting]).join(', ');
    throw new Error(`Sentry settings in the environment are incomplete: ${names} not set`);
  }
  if (record.apiUrl !== undefined) {
    record.apiUrl = trimBareTrailingSlash(record.apiUrl);
  }
  try {
    return parseSentrySettings(record);
  } catch (error) {
    throw new Error(nameVariableIn(error.message));
  }
}

/**
 * Read the attempt's Sentry settings: the event's from `env` when it sets them, else the package's.
 *
 * @returns {Promise<ReturnType<typeof parseSentrySettings> | null>} `null` when neither has
 *   settings ready for live mode.
 */
async function readSentrySettings(env, packageDir) {
  const fromEnvironment = readSentryEnvironment(env);
  if (fromEnvironment !== null) {
    return fromEnvironment;
  }

  return readSentryConfig(packageDir);
}

/**
 * Decide the attempt's mode from the Sentry settings and `env`.
 *
 * @returns {Promise<{ sentry: ReturnType<typeof parseSentrySettings> | null, note: string | null }>}
 *   `sentry` is `null` for demo mode; `note` says why live mode is off when the settings are ready
 *   for it, and is `null` otherwise.
 */
export async function decideMode(env, packageDir) {
  const sentry = await readSentrySettings(env, packageDir);
  if (sentry === null) {
    return { sentry: null, note: null };
  }
  if ((env[SENTRY_TOKEN_VARIABLE] ?? '') === '') {
    return { sentry: null, note: `live Sentry mode is off: ${SENTRY_TOKEN_VARIABLE} is not set` };
  }

  return { sentry, note: null };
}

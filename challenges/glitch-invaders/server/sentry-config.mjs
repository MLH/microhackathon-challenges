/**
 * Live or demo: live Sentry mode needs both halves, the public settings in the package's
 * `sentry.json` and `SENTRY_AUTH_TOKEN` in the environment, where the station's vault puts a
 * placeholder it swaps for the real token on the way out. Anything less is demo mode.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSentrySettings } from '../shared/runtime-config.mjs';

/** The package file holding the public Sentry settings. */
export const SENTRY_CONFIG_FILE_NAME = 'sentry.json';

/** The variable the vault's `sentry` service sets, and the one Sentry's own tools read. */
export const SENTRY_TOKEN_VARIABLE = 'SENTRY_AUTH_TOKEN';

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
 * Decide the attempt's mode from the package config and `env`.
 *
 * @returns {Promise<{ sentry: ReturnType<typeof parseSentrySettings> | null, note: string | null }>}
 *   `sentry` is `null` for demo mode; `note` says why live mode is off when the package is ready
 *   for it, and is `null` otherwise.
 */
export async function decideMode(env, packageDir) {
  const sentry = await readSentryConfig(packageDir);
  if (sentry === null) {
    return { sentry: null, note: null };
  }
  if ((env[SENTRY_TOKEN_VARIABLE] ?? '') === '') {
    return { sentry: null, note: `live Sentry mode is off: ${SENTRY_TOKEN_VARIABLE} is not set` };
  }

  return { sentry, note: null };
}

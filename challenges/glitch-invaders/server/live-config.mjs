/**
 * Live Sentry settings. Boothstrap hooks only receive the vault's variables, so there is no
 * station-level channel for a Sentry DSN yet; staff supply the settings either as environment
 * variables or in a git-ignored `live.config.json` next to `challenge.json`. Environment wins.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { LIVE_SETTING_NAMES } from '../shared/runtime-config.mjs';

/** The file name staff provision. */
export const LIVE_CONFIG_FILE_NAME = 'live.config.json';

/** Optional `.env` file in the package root, supporting both `GLITCH_*` and `VITE_*` keys. */
export const DOTENV_FILE_NAME = '.env';

/** Map `VITE_*` keys from the original Glitch Invaders `.env` format to `GLITCH_*` keys. */
const ENV_ALIASES = [
  ['GLITCH_SENTRY_DSN', 'VITE_SENTRY_DSN'],
  ['GLITCH_SENTRY_ORG', 'VITE_SENTRY_ORG'],
  ['GLITCH_SENTRY_PROJECT', 'VITE_SENTRY_PROJECT'],
  ['GLITCH_SENTRY_ENVIRONMENT', 'VITE_SENTRY_ENVIRONMENT'],
];

/** Parse a simple `.env` file for `GLITCH_*` or `VITE_*` Sentry settings. */
async function readDotenvFile(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return {};
  }

  const entries = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value !== '') {
      entries[key] = value;
    }
  }

  const values = {};
  for (const [target, alias] of ENV_ALIASES) {
    if (entries[alias] !== undefined) {
      values[target] = entries[alias];
    }
  }
  for (const name of LIVE_SETTING_NAMES) {
    if (entries[name] !== undefined) {
      values[name] = entries[name];
    }
  }

  return values;
}

/** Read the staff-provisioned file, returning nothing for a missing one and a note for a bad one. */
async function readLiveFile(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { values: {}, note: null };
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { values: {}, note: `${path.basename(file)} must be a JSON object` };
    }

    const record = parsed;
    const values = {};
    for (const [target, alias] of ENV_ALIASES) {
      const value = record[alias];
      if (typeof value === 'string') {
        values[target] = value;
      }
    }
    for (const name of LIVE_SETTING_NAMES) {
      const value = record[name];
      if (typeof value === 'string') {
        values[name] = value;
      }
    }

    return { values, note: null };
  } catch {
    return { values: {}, note: `${path.basename(file)} is not valid JSON` };
  }
}

/** Combine `.env`, `live.config.json`, and the environment into one settings source. */
export async function readLiveSource(env, packageDir) {
  const fromDotenv =
    env.GLITCH_LIVE_CONFIG === undefined
      ? await readDotenvFile(path.join(packageDir, DOTENV_FILE_NAME))
      : {};
  const file = env.GLITCH_LIVE_CONFIG ?? path.join(packageDir, LIVE_CONFIG_FILE_NAME);
  const fromFile = await readLiveFile(file);
  const source = { ...fromDotenv, ...fromFile.values };
  for (const [target, alias] of ENV_ALIASES) {
    const value = env[alias];
    if (value !== undefined && value !== '') {
      source[target] = value;
    }
  }
  for (const name of LIVE_SETTING_NAMES) {
    const value = env[name];
    if (value !== undefined && value !== '') {
      source[name] = value;
    }
  }

  return { source, note: fromFile.note };
}

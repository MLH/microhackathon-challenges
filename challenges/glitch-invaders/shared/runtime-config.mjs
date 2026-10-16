/** The environment names read for live settings, shared by the env and file readers. */
export const LIVE_SETTING_NAMES = [
  'GLITCH_SENTRY_DSN',
  'GLITCH_SENTRY_ORG',
  'GLITCH_SENTRY_PROJECT',
  'GLITCH_SENTRY_ENVIRONMENT',
  'GLITCH_MODE',
];

/** Default idle time before the warning, under Boothstrap's own 3 minute idle timeout. */
export const DEFAULT_INACTIVITY_WARNING_MS = 120_000;

/** How long the warning counts down before the run resets. */
export const DEFAULT_INACTIVITY_RESET_MS = 30_000;

/** Thrown when a served or stored runtime config is malformed. */
export class InvalidRuntimeConfigError extends Error {
  constructor(reason) {
    super(`invalid runtime config: ${reason}`);
    this.name = 'InvalidRuntimeConfigError';
  }
}

/** Whether `dsn` looks like `https://<key>@<host>/<project id>`. */
export function isValidDsn(dsn) {
  try {
    const url = new URL(dsn);
    return (
      url.protocol === 'https:' &&
      url.username.length > 0 &&
      url.hostname.length > 0 &&
      /^\/\d+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/** Whether `value` is a Sentry slug, as used in organization and project URLs. */
function isSlug(value) {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value);
}

/**
 * Choose live or demo from the provided settings. Live needs a valid DSN plus the organization and
 * project slugs that build evidence links; anything less is demo, with a reason naming what is
 * missing so staff can fix it without the game ever failing to start.
 */
export function decideMode(source) {
  if (source.GLITCH_MODE === 'demo') {
    return { sentry: null, demoReason: 'GLITCH_MODE is demo' };
  }

  const dsn = source.GLITCH_SENTRY_DSN?.trim() ?? '';
  const org = source.GLITCH_SENTRY_ORG?.trim() ?? '';
  const project = source.GLITCH_SENTRY_PROJECT?.trim() ?? '';
  if (dsn === '' && org === '' && project === '') {
    return { sentry: null, demoReason: null };
  }

  const problems = [];
  if (!isValidDsn(dsn)) {
    problems.push('GLITCH_SENTRY_DSN is missing or not a Sentry DSN');
  }
  if (!isSlug(org)) {
    problems.push('GLITCH_SENTRY_ORG is missing or not a slug');
  }
  if (!isSlug(project)) {
    problems.push('GLITCH_SENTRY_PROJECT is missing or not a slug');
  }
  if (problems.length > 0) {
    return { sentry: null, demoReason: `live settings incomplete: ${problems.join('; ')}` };
  }

  const environment = source.GLITCH_SENTRY_ENVIRONMENT?.trim();

  return {
    sentry: { dsn, org, project, environment: environment || 'booth' },
    demoReason: null,
  };
}

/** Read `key` from `record` as a finite number within `[min, max]`. */
function readDuration(record, key, min, max) {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new InvalidRuntimeConfigError(`${key} must be a number from ${min} to ${max}`);
  }

  return value;
}

/** Read `key` from `record` as a string or `null`. */
function readNullableText(record, key) {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string' || value.length > 128) {
    throw new InvalidRuntimeConfigError(`${key} must be a short string or null`);
  }

  return value;
}

/** Validate the Sentry part of a served config. */
function parseSentrySettings(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRuntimeConfigError('sentry must be an object or null');
  }

  const record = value;
  const { dsn, org, project, environment } = record;
  if (typeof dsn !== 'string' || !isValidDsn(dsn)) {
    throw new InvalidRuntimeConfigError('sentry.dsn must be a Sentry DSN');
  }
  if (typeof org !== 'string' || !isSlug(org) || typeof project !== 'string' || !isSlug(project)) {
    throw new InvalidRuntimeConfigError('sentry.org and sentry.project must be slugs');
  }
  if (typeof environment !== 'string' || environment === '') {
    throw new InvalidRuntimeConfigError('sentry.environment must be a non-empty string');
  }

  return { dsn, org, project, environment };
}

/**
 * Validate untrusted JSON as a {@link RuntimeConfig}, requiring `mode` to agree with `sentry`.
 *
 * @throws {InvalidRuntimeConfigError} when a field is missing, malformed, or contradicts `mode`.
 */
export function parseRuntimeConfig(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRuntimeConfigError('config must be an object');
  }

  const record = value;
  const { attemptId, mode } = record;
  if (typeof attemptId !== 'string' || !/^[a-z0-9-]{4,64}$/.test(attemptId)) {
    throw new InvalidRuntimeConfigError(
      'attemptId must be 4 to 64 lowercase letters, digits, or hyphens',
    );
  }
  if (mode !== 'demo' && mode !== 'live') {
    throw new InvalidRuntimeConfigError('mode must be demo or live');
  }

  const sentry = parseSentrySettings(record.sentry);
  if ((mode === 'live') !== (sentry !== null)) {
    throw new InvalidRuntimeConfigError(
      'live mode needs sentry settings, and demo mode must have none',
    );
  }

  return {
    attemptId,
    mode,
    stationId: readNullableText(record, 'stationId'),
    sessionId: readNullableText(record, 'sessionId'),
    inactivityWarningMs: readDuration(record, 'inactivityWarningMs', 1_000, 3_600_000),
    inactivityResetMs: readDuration(record, 'inactivityResetMs', 1_000, 600_000),
    sentry,
  };
}

/** The config the game falls back to when none is served, such as under `vite dev`. */
export function createDemoRuntimeConfig(attemptId) {
  return {
    attemptId,
    mode: 'demo',
    stationId: null,
    sessionId: null,
    inactivityWarningMs: DEFAULT_INACTIVITY_WARNING_MS,
    inactivityResetMs: DEFAULT_INACTIVITY_RESET_MS,
    sentry: null,
  };
}

/**
 * The attempt's runtime config: setup writes it, the page server serves it as
 * `/runtime-config.json`, and the page reads it to tie saved progress to this attempt. A live
 * attempt also carries the public Sentry settings; demo has none. No secret is ever in it.
 */

/** The Sentry API the vault injects the token for, unless the package config names another. */
export const DEFAULT_SENTRY_API_URL = 'https://sentry.io';

/** Thrown when a served or stored runtime config is malformed. */
export class InvalidRuntimeConfigError extends Error {
  constructor(reason) {
    super(`invalid runtime config: ${reason}`);
    this.name = 'InvalidRuntimeConfigError';
  }
}

/** Whether `dsn` looks like `https://<public key>@<ingest host>/<project id>`. */
function isDsn(dsn) {
  const url = URL.parse(dsn);

  return (
    url !== null &&
    url.protocol === 'https:' &&
    url.username !== '' &&
    url.password === '' &&
    /^\/\d+$/.test(url.pathname)
  );
}

/** Whether `value` is a Sentry organization or project slug. */
function isSlug(value) {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
}

/**
 * Whether `apiUrl` is a Sentry API origin the token may go to: `https://sentry.io` or a subdomain of
 * it, or a plain-HTTP loopback origin such as a local stand-in. Any other host would receive the
 * real token in `boothstrap dev` or a standalone run.
 */
export function isSentryApiOrigin(apiUrl) {
  const url = URL.parse(apiUrl);
  if (url === null || url.origin !== apiUrl) {
    return false;
  }
  if (url.protocol === 'http:') {
    return ['127.0.0.1', 'localhost'].includes(url.hostname);
  }

  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    (url.hostname === 'sentry.io' || url.hostname.endsWith('.sentry.io'))
  );
}

/**
 * Validate untrusted JSON as the public Sentry settings, with `apiUrl` defaulting to
 * {@link DEFAULT_SENTRY_API_URL}.
 *
 * @returns {{ dsn: string, org: string, project: string, apiUrl: string }}
 * @throws {InvalidRuntimeConfigError} naming the first field that is missing or malformed.
 */
export function parseSentrySettings(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRuntimeConfigError('sentry must be an object');
  }

  const { dsn, org, project, apiUrl = DEFAULT_SENTRY_API_URL } = value;
  if (typeof dsn !== 'string' || !isDsn(dsn)) {
    throw new InvalidRuntimeConfigError('sentry.dsn must be a Sentry DSN');
  }
  if (typeof org !== 'string' || !isSlug(org)) {
    throw new InvalidRuntimeConfigError('sentry.org must be a Sentry slug');
  }
  if (typeof project !== 'string' || !isSlug(project)) {
    throw new InvalidRuntimeConfigError('sentry.project must be a Sentry slug');
  }
  if (typeof apiUrl !== 'string' || !isSentryApiOrigin(apiUrl)) {
    throw new InvalidRuntimeConfigError('sentry.apiUrl must be https://sentry.io or a subdomain');
  }

  return { dsn, org, project, apiUrl };
}

/** The origin the page sends Sentry envelopes to, which the page's CSP must allow. */
export function ingestOrigin(dsn) {
  return new URL(dsn).origin;
}

/**
 * Validate untrusted JSON as a runtime config.
 *
 * @returns {{ attemptId: string, sentry?: ReturnType<typeof parseSentrySettings> }} with `sentry`
 *   only in live mode.
 * @throws {InvalidRuntimeConfigError} when it is not an object, `attemptId` is malformed, or
 *   `sentry` is present but malformed.
 */
export function parseRuntimeConfig(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRuntimeConfigError('config must be an object');
  }

  const { attemptId } = value;
  if (typeof attemptId !== 'string' || !/^[a-z0-9-]{4,64}$/.test(attemptId)) {
    throw new InvalidRuntimeConfigError(
      'attemptId must be 4 to 64 lowercase letters, digits, or hyphens',
    );
  }
  if (value.sentry === undefined) {
    return { attemptId };
  }

  return { attemptId, sentry: parseSentrySettings(value.sentry) };
}

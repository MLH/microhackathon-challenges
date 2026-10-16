/** The Sentry web address of the organization. */
function organizationUrl(settings) {
  return `https://${encodeURIComponent(settings.org)}.sentry.io`;
}

/**
 * A search for the issue about `bug`. Searching by the stable `bug` tag rather than a fresh
 * per-run UUID matches the issue in Sentry immediately before single-event indexing finishes.
 */
export function issueSearchUrl(settings, _attemptId, bug) {
  const query = encodeURIComponent(`bug:${bug}`);

  return `${organizationUrl(settings)}/issues/?query=${query}&statsPeriod=14d`;
}

/** The trace view for `traceId`. */
export function traceUrl(settings, traceId) {
  return `${organizationUrl(settings)}/explore/traces/trace/${encodeURIComponent(traceId)}/`;
}

/**
 * The Sentry API calls the page server makes for live evidence. The token stays inside this client:
 * it goes only into the Authorization header of requests to the configured API, and no error or
 * result ever carries it. On a station the request leaves through the vault proxy, which swaps the
 * placeholder token for the real one.
 */

/** How long one API request may take before it counts as an outage. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Waits between lookups of something Sentry has accepted but not yet indexed, about 15 seconds in
 * all; an event or trace usually appears within a few.
 */
export const INDEXING_RETRY_DELAYS_MS = [1_000, 2_000, 3_000, 4_000, 5_000];

/** Sentry did not answer usefully. The message names the request, never the token. */
export class SentryUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SentryUnavailableError';
  }
}

/** Pause for `milliseconds`. */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Reads one Sentry organization and project with a bearer token. */
export class SentryApi {
  #token;

  /**
   * @param {{ apiUrl: string, org: string, project: string, token: string, sleep?: Function,
   *   retryDelaysMs?: number[] }} options `sleep` and `retryDelaysMs` let tests skip the waits.
   */
  constructor(options) {
    this.apiUrl = options.apiUrl;
    this.org = options.org;
    this.project = options.project;
    this.#token = options.token;
    this.sleep = options.sleep ?? sleep;
    this.retryDelaysMs = options.retryDelaysMs ?? INDEXING_RETRY_DELAYS_MS;
  }

  /** One error event, by the id the page gave it; waits while Sentry is still indexing it. */
  event(eventId) {
    const org = encodeURIComponent(this.org);
    const project = encodeURIComponent(this.project);

    return this.untilIndexed(() => this.get(`/api/0/projects/${org}/${project}/events/${eventId}/`));
  }

  /** The issue an event was grouped into. */
  async issue(groupId) {
    const org = encodeURIComponent(this.org);
    const issue = await this.get(
      `/api/0/organizations/${org}/issues/${encodeURIComponent(groupId)}/`,
    );
    if (issue === null) {
      throw new SentryUnavailableError(`Sentry has no issue ${groupId}`);
    }

    return issue;
  }

  /** The boss-load spans of trace `traceId`, oldest first; waits while Sentry is indexing them. */
  traceSpans(traceId) {
    const query = new URLSearchParams({
      dataset: 'spans',
      query: `trace:${traceId} span.op:game.resource.load`,
      sort: 'precise.start_ts',
      statsPeriod: '24h',
      per_page: '20',
    });
    for (const field of ['span.description', 'span.op', 'span.duration', 'precise.start_ts']) {
      query.append('field', field);
    }
    const resource = `/api/0/organizations/${encodeURIComponent(this.org)}/events/?${query}`;

    return this.untilIndexed(async () => {
      const result = await this.get(resource);
      const rows = Array.isArray(result?.data) ? result.data : [];

      return rows.length === 0 ? null : rows;
    });
  }

  /**
   * Run `lookup` until it finds something, waiting {@link INDEXING_RETRY_DELAYS_MS} between tries.
   * An outage fails at once; only "not there yet" is retried.
   */
  async untilIndexed(lookup) {
    for (const delayMs of [...this.retryDelaysMs, null]) {
      const found = await lookup();
      if (found !== null) {
        return found;
      }
      if (delayMs === null) {
        break;
      }
      await this.sleep(delayMs);
    }

    throw new SentryUnavailableError('Sentry has not indexed the report yet');
  }

  /**
   * GET `resource` from the API as JSON.
   *
   * @returns {Promise<unknown | null>} the body, or `null` for a 404.
   * @throws {SentryUnavailableError} for a network failure, a timeout, or any other non-200 status.
   */
  async get(resource) {
    const pathname = resource.split('?')[0];
    let response;
    try {
      response = await fetch(`${this.apiUrl}${resource}`, {
        headers: { authorization: `Bearer ${this.#token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new SentryUnavailableError(`Sentry did not answer ${pathname}`);
    }
    if (response.status === 404) {
      await response.body?.cancel();

      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SentryUnavailableError(`Sentry answered ${pathname} with ${response.status}`);
    }

    try {
      return await response.json();
    } catch {
      throw new SentryUnavailableError(`Sentry answered ${pathname} with a body that is not JSON`);
    }
  }
}

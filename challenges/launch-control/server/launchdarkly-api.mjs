/**
 * The LaunchDarkly REST calls the hooks and the MCP tool make: read the booker config's targeting,
 * and move one session's individual target between variations. Nothing here touches the default
 * rule or any other context key. The token goes only into the Authorization header of requests to
 * the configured origin, and no error or result carries it. On a station each request leaves
 * through the vault proxy, which swaps the placeholder token for the real one.
 */

import { sleep } from './http.mjs';

/** How long one request may take. */
const REQUEST_TIMEOUT_MS = 8_000;

/** The longest a rate-limited call keeps retrying before it gives up. */
const RATE_LIMIT_BUDGET_MS = 12_000;

/** The longest one rate-limit wait, whatever LaunchDarkly's reset time says. */
const MAX_RATE_LIMIT_WAIT_MS = 5_000;

/** The content type a semantic patch needs. */
export const SEMANTIC_PATCH_TYPE = 'application/json; domain-model=launchdarkly.semanticpatch';

/** LaunchDarkly did not answer usefully. The message names the request, never the token. */
export class LaunchDarklyApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'LaunchDarklyApiError';
    this.status = status;
  }
}

/** How long a 429 asks the caller to wait, from `Retry-After` or LaunchDarkly's reset time. */
function rateLimitWait(response) {
  const retryAfterSeconds = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }
  const resetAt = Number(response.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(resetAt) && resetAt > Date.now()) {
    return resetAt - Date.now();
  }

  return 1_000;
}

/** LaunchDarkly's own error message from a response body, cut short, or the status alone. */
function describeFailure(status, text) {
  let message = '';
  try {
    message = String(JSON.parse(text).message ?? '');
  } catch {
    message = '';
  }

  return message === '' ? `HTTP ${status}` : `HTTP ${status}: ${message.slice(0, 200)}`;
}

/**
 * Send one LaunchDarkly REST request with `token`, waiting out rate limits within
 * {@link RATE_LIMIT_BUDGET_MS}.
 *
 * @param {{ origin: string, token: string }} connection
 * @param {{ method: string, path: string, body?: object, contentType?: string }} request `path`
 *   starts with `/api/v2`; `contentType` defaults to JSON.
 * @returns {Promise<object | null>} the JSON answer, or `null` for an empty one.
 * @throws {LaunchDarklyApiError} on a network failure, a timeout, or a non-2xx answer; its
 *   `status` is 0 for the first two.
 */
export async function requestLaunchDarkly(connection, { method, path, body, contentType = 'application/json' }) {
  const deadline = Date.now() + RATE_LIMIT_BUDGET_MS;
  for (;;) {
    let response;
    try {
      response = await fetch(`${connection.origin}${path}`, {
        method,
        headers: { authorization: connection.token, ...(body === undefined ? {} : { 'content-type': contentType }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? 'timed out' : 'could not connect';
      throw new LaunchDarklyApiError(`LaunchDarkly ${method} ${path} ${reason}`, 0);
    }

    const text = await response.text();
    if (response.ok) {
      return text === '' ? null : JSON.parse(text);
    }
    const wait = Math.min(rateLimitWait(response), MAX_RATE_LIMIT_WAIT_MS);
    if (response.status !== 429 || Date.now() + wait > deadline) {
      throw new LaunchDarklyApiError(`LaunchDarkly ${method} ${path} failed: ${describeFailure(response.status, text)}`, response.status);
    }
    await sleep(wait);
  }
}

/** Reads and retargets one AgentControl config in one environment. */
export class LaunchDarklyApi {
  #connection;

  /**
   * @param {{ origin: string, token: string, projectKey: string, environmentKey: string,
   *   configKey: string }} options
   */
  constructor(options) {
    this.projectKey = options.projectKey;
    this.environmentKey = options.environmentKey;
    this.configKey = options.configKey;
    this.#connection = { origin: options.origin, token: options.token };
  }

  /** The config's targeting resource path. */
  get targetingPath() {
    const project = encodeURIComponent(this.projectKey);
    const config = encodeURIComponent(this.configKey);

    return `/api/v2/projects/${project}/ai-configs/${config}/targeting`;
  }

  /** Read or patch the config's targeting. */
  request(method, body) {
    return requestLaunchDarkly(this.#connection, { method, path: this.targetingPath, body, contentType: SEMANTIC_PATCH_TYPE });
  }

  /**
   * Read the config's variations and this environment's individual targets.
   *
   * @returns {Promise<{ variationIds: Map<string, string>, targetOf: (contextKey: string) =>
   *   string | null }>} the variation id for each variation key, and the variation key a context
   *   key is individually targeted to, or `null` when it has no individual target.
   * @throws {LaunchDarklyApiError} when the config or environment is missing.
   */
  async readTargeting() {
    const targeting = await this.request('GET');
    const variations = targeting?.variations ?? [];
    const variationIds = new Map(variations.map((variation) => [variation.key ?? variation.name, variation._id]));
    const environment = targeting?.environments?.[this.environmentKey];
    if (environment === undefined) {
      throw new LaunchDarklyApiError(`LaunchDarkly has no environment ${this.environmentKey} on this config`, 404);
    }
    const targets = [...(environment.targets ?? []), ...(environment.contextTargets ?? [])].filter(
      (target) => (target.contextKind ?? 'user') === 'user',
    );

    const targetOf = (contextKey) => {
      const target = targets.find((candidate) => candidate.values?.includes(contextKey));
      if (target === undefined) {
        return null;
      }
      const variation = variations[target.variation];

      return variation === undefined ? null : (variation.key ?? variation.name);
    };

    return { variationIds, targetOf };
  }

  /** Send a semantic patch to this environment's targeting. */
  patch(instructions, comment) {
    return this.request('PATCH', { environmentKey: this.environmentKey, comment, instructions });
  }

  /**
   * Target `contextKey` individually to the variation `variationKey`, moving it off any other.
   *
   * @throws {LaunchDarklyApiError} when the config has no such variation, or LaunchDarkly refuses.
   */
  async targetSession(contextKey, variationKey) {
    const { variationIds, targetOf } = await this.readTargeting();
    const variationId = variationIds.get(variationKey);
    if (variationId === undefined) {
      throw new LaunchDarklyApiError(`the config has no variation ${variationKey}; run provision.mjs`, 404);
    }
    const current = targetOf(contextKey);
    if (current === variationKey) {
      return;
    }

    const instructions = [];
    if (current !== null) {
      instructions.push({ kind: 'removeTargets', contextKind: 'user', values: [contextKey], variationId: variationIds.get(current) });
    }
    instructions.push({ kind: 'addTargets', contextKind: 'user', values: [contextKey], variationId });
    await this.patch(instructions, `Launch Control: switch one session to ${variationKey}`);
  }

  /**
   * Remove `contextKey`'s individual target, if it has one. A key with no target is left alone,
   * so this is safe to repeat.
   *
   * @returns {Promise<string | null>} the variation key it was removed from, or `null`.
   */
  async removeSession(contextKey) {
    const { variationIds, targetOf } = await this.readTargeting();
    const current = targetOf(contextKey);
    if (current === null) {
      return null;
    }

    const variationId = variationIds.get(current);
    await this.patch(
      [{ kind: 'removeTargets', contextKind: 'user', values: [contextKey], variationId }],
      'Launch Control: remove one session',
    );

    return current;
  }
}

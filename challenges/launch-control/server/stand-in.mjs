/**
 * A local stand-in for the two LaunchDarkly surfaces the challenge uses, built from `ladder.json`:
 * the SDK's streaming endpoint, which delivers the booker config, and the REST endpoint that reads
 * and patches its targeting. Demo mode mounts it on the page server, so the SDK client and the
 * MCP tool run exactly as they do live, against this instead of LaunchDarkly. It speaks only the
 * subset those callers use: one config, one environment, user-kind individual targets, and the
 * `addTargets` and `removeTargets` semantic-patch instructions.
 */
import { randomUUID } from 'node:crypto';
import { readBody, sendJson } from './http.mjs';
import { variationValue } from './ladder.mjs';

/** The SDK's streaming path, relative to the stream origin. */
const STREAM_PATH = '/all';

/** How often the stream sends a comment, so idle connections stay open. */
const HEARTBEAT_MS = 15_000;

/** The largest targeting patch the stand-in reads. */
const MAX_PATCH_BYTES = 16 * 1024;

/** One AgentControl config with individual targets, served the way LaunchDarkly serves it. */
export class LaunchDarklyStandIn {
  #streams = new Set();
  #heartbeat;

  /**
   * @param {{ ladder: ReturnType<typeof import('./ladder.mjs').parseLadder>, projectKey: string,
   *   environmentKey: string, configKey: string }} options
   */
  constructor(options) {
    this.ladder = options.ladder;
    this.projectKey = options.projectKey;
    this.environmentKey = options.environmentKey;
    this.configKey = options.configKey;
    this.variations = [
      { key: 'disabled', name: 'disabled', _id: randomUUID(), value: { _ldMeta: { enabled: false } } },
      ...options.ladder.rungs.map((rung) => ({
        key: rung.key,
        name: rung.key,
        _id: randomUUID(),
        value: variationValue(options.ladder, rung),
      })),
    ];
    this.targets = new Map();
    this.version = 1;
    this.requests = [];
    this.#heartbeat = setInterval(() => this.#broadcast(':\n\n'), HEARTBEAT_MS);
    this.#heartbeat.unref();
  }

  /** The targeting path the REST client uses. */
  get targetingPath() {
    return `/api/v2/projects/${this.projectKey}/ai-configs/${this.configKey}/targeting`;
  }

  /** The config as an SDK flag, with the variation index each targeted key gets. */
  flag() {
    const byVariation = new Map();
    for (const [contextKey, index] of this.targets) {
      byVariation.set(index, [...(byVariation.get(index) ?? []), contextKey]);
    }

    return {
      key: this.configKey,
      version: this.version,
      on: true,
      prerequisites: [],
      targets: [...byVariation].map(([variation, values]) => ({ values, variation })),
      contextTargets: [],
      rules: [],
      fallthrough: { variation: 1 },
      offVariation: 0,
      variations: this.variations.map((variation) => variation.value),
      salt: 'launch-control-demo',
      trackEvents: false,
      trackEventsFallthrough: false,
      clientSide: false,
      deleted: false,
    };
  }

  /**
   * Answer `request` when `pathname` is one of the stand-in's routes.
   *
   * @returns {boolean} whether the stand-in answered it.
   */
  handle(request, response, pathname) {
    if (request.method === 'GET' && pathname === STREAM_PATH) {
      this.#record(request, pathname);
      this.#openStream(request, response);

      return true;
    }
    if (pathname === this.targetingPath && request.method === 'GET') {
      this.#record(request, pathname);
      sendJson(response, 200, this.#targetingResource());

      return true;
    }
    if (pathname === this.targetingPath && request.method === 'PATCH') {
      this.#patch(request, response, pathname);

      return true;
    }

    return false;
  }

  /** Close every open stream, so the server holding the stand-in can stop. */
  close() {
    clearInterval(this.#heartbeat);
    for (const stream of this.#streams) {
      stream.end();
    }
    this.#streams.clear();
  }

  /** Note who asked for what, so tests can assert on the requests. */
  #record(request, pathname, body) {
    this.requests.push({
      method: request.method,
      path: pathname,
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'],
      ...(body === undefined ? {} : { body }),
    });
  }

  /** Start an SSE stream with the whole data set, as the SDK expects on connect. */
  #openStream(request, response) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const data = { path: '/', data: { flags: { [this.configKey]: this.flag() }, segments: {} } };
    response.write(`event: put\ndata: ${JSON.stringify(data)}\n\n`);
    this.#streams.add(response);
    request.once('close', () => this.#streams.delete(response));
  }

  /** Send `chunk` to every open stream. */
  #broadcast(chunk) {
    for (const stream of this.#streams) {
      stream.write(chunk);
    }
  }

  /** The REST targeting resource: variations with ids, and this environment's targets. */
  #targetingResource() {
    const flag = this.flag();

    return {
      key: this.configKey,
      variations: this.variations.map(({ key, name, _id }) => ({ key, name, _id })),
      environments: {
        [this.environmentKey]: {
          targets: flag.targets.map((target) => ({ contextKind: 'user', ...target })),
          contextTargets: [],
          fallthrough: flag.fallthrough,
          offVariation: flag.offVariation,
          rules: [],
        },
      },
    };
  }

  /** Apply a semantic patch of `addTargets` and `removeTargets`, all or nothing. */
  async #patch(request, response, pathname) {
    const text = await readBody(request, MAX_PATCH_BYTES);
    let body;
    try {
      body = JSON.parse(text ?? '');
    } catch {
      body = undefined;
    }
    this.#record(request, pathname, body);

    /** Answer 400 with LaunchDarkly's error shape. */
    const refuse = (message) => sendJson(response, 400, { code: 'invalid_request', message });
    if (!String(request.headers['content-type']).includes('domain-model=launchdarkly.semanticpatch')) {
      refuse('a semantic patch needs its content type');

      return;
    }
    if (body?.environmentKey !== this.environmentKey || !Array.isArray(body.instructions)) {
      refuse('environmentKey and instructions are required');

      return;
    }

    const targets = new Map(this.targets);
    for (const instruction of body.instructions) {
      const index = this.variations.findIndex((variation) => variation._id === instruction.variationId);
      if (index < 0) {
        refuse('instruction variationId is required');

        return;
      }
      for (const contextKey of instruction.values ?? []) {
        if (instruction.kind === 'addTargets') {
          if (targets.has(contextKey) && targets.get(contextKey) !== index) {
            refuse(`${contextKey} is already targeted to another variation`);

            return;
          }
          targets.set(contextKey, index);
        } else if (instruction.kind === 'removeTargets') {
          if (targets.get(contextKey) === index) {
            targets.delete(contextKey);
          }
        } else {
          refuse(`instruction kind '${instruction.kind}' unsupported`);

          return;
        }
      }
    }

    this.targets = targets;
    this.version += 1;
    this.#broadcast(`event: patch\ndata: ${JSON.stringify({ path: `/flags/${this.configKey}`, data: this.flag() })}\n\n`);
    sendJson(response, 200, this.#targetingResource());
  }
}

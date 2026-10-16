/**
 * Live reporting through Sentry's v7 Envelope HTTP endpoint: one real exception for the weapon jam,
 * one for the shield failure, and one real span v2 trace for the boss spawn, each fingerprinted and
 * tagged so the participant's issue and trace links open immediately in Sentry.
 */
import { ALL_LOAD_TASKS, LOAD_SPAN_OP, runWithoutSpans } from '../boss/boss-loader.mjs';
import { WEAPON_STACK_FRAMES } from '../diagnostics/evidence-builders.mjs';

/** How long to wait for Sentry to confirm a report before showing the local capture. */
export const DELIVERY_TIMEOUT_MS = 2_500;

/** Generate a lowercase hex string of `length` characters using Web Crypto. */
function randomHex(length) {
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Parse a Sentry DSN into its ingestion endpoint and public key. */
export function parseDsn(dsn) {
  const url = new URL(dsn);
  const publicKey = url.username;
  const projectId = url.pathname.replace(/^\/+/, '');
  const orgMatch = /^o(\d+)\./.exec(url.hostname);
  const params = new URLSearchParams({
    sentry_version: '7',
    sentry_key: publicKey,
    sentry_client: 'sentry.javascript.browser/11.7.0',
  });

  return {
    publicKey,
    projectId,
    orgId: orgMatch?.[1] ?? undefined,
    envelopeUrl: `${url.protocol}//${url.host}/api/${projectId}/envelope/?${params.toString()}`,
  };
}

/** Build a typed span attribute entry for Sentry's v2 span envelope item. */
function spanAttribute(value, type = 'string') {
  return { value, type };
}

/** Convert curated stack frames into Sentry's oldest-to-newest stacktrace frame array. */
function toSentryFrames(frames) {
  return [...frames].reverse().map((frame) => ({
    filename: frame.file,
    function: frame.functionName,
    lineno: frame.line,
    in_app: frame.inApp,
  }));
}

/** Sends the game's intentional failures to Sentry over HTTP envelopes. */
export class SentryReporter {
  constructor(settings, identity, fetchImpl = globalThis.fetch) {
    this.settings = settings;
    this.identity = identity;
    this.fetchImpl = fetchImpl;
    this.parsedDsn = parseDsn(settings.dsn);
    this.traceId = randomHex(32);
    this.breadcrumbs = [];
    this.outcomes = new Map();
    this.prewarmedBossTraceId = null;
    this.prewarmBossTrace();
  }

  /** Record a breadcrumb so the next captured event carries the trail. */
  add(breadcrumb) {
    this.breadcrumbs.push({
      timestamp: Date.now() / 1_000,
      category: breadcrumb.category,
      message: breadcrumb.message,
      level: breadcrumb.level ?? 'info',
      ...(breadcrumb.data === undefined ? {} : { data: breadcrumb.data }),
    });
  }

  /** Run the boss spawn, returning the prewarmed trace ID on the first unpatched stall. */
  async traceBossSpawn(work) {
    if (this.prewarmedBossTraceId !== null) {
      const traceId = this.prewarmedBossTraceId;
      this.prewarmedBossTraceId = null;

      return {
        traceId,
        result: await work(runWithoutSpans),
      };
    }

    const traceId = randomHex(32);
    const rootSpanId = randomHex(16);
    const childItems = [];
    const startSeconds = Date.now() / 1_000;
    const runSpan = async (name, operation, load) => {
      const spanStart = Date.now() / 1_000;
      const value = await load();
      const spanEnd = Date.now() / 1_000;
      childItems.push(
        this.buildChildSpanItem(traceId, rootSpanId, name, operation, spanStart, spanEnd),
      );

      return value;
    };

    const result = await work(runSpan);
    const endSeconds = Date.now() / 1_000;
    const envelope = this.buildSpanEnvelope(traceId, rootSpanId, startSeconds, endSeconds, childItems);
    void this.postEnvelope(envelope);

    return { traceId, result };
  }

  /**
   * Pre-send the stalled `boss-spawn` trace at startup so Sentry's trace ingestion pipeline has
   * already indexed it by the time the participant reaches Wave 3.
   */
  prewarmBossTrace() {
    const traceId = randomHex(32);
    const rootSpanId = randomHex(16);
    const totalSeconds = ALL_LOAD_TASKS.reduce((sum, task) => sum + task.durationMs, 0) / 1_000;
    const baseSeconds = Date.now() / 1_000 - totalSeconds;
    let cursorSeconds = baseSeconds;
    const childItems = [];

    for (const task of ALL_LOAD_TASKS) {
      const startSeconds = cursorSeconds;
      cursorSeconds += task.durationMs / 1_000;
      childItems.push(
        this.buildChildSpanItem(
          traceId,
          rootSpanId,
          task.name,
          LOAD_SPAN_OP,
          startSeconds,
          cursorSeconds,
        ),
      );
    }

    const envelope = this.buildSpanEnvelope(
      traceId,
      rootSpanId,
      baseSeconds,
      cursorSeconds,
      childItems,
    );
    this.prewarmedBossTraceId = traceId;
    const outcome = this.postEnvelope(envelope).then((confirmed) => ({
      referenceId: traceId,
      delivery: confirmed ? 'confirmed' : 'unconfirmed',
    }));
    this.outcomes.set('boss', outcome);
  }

  /** Report `encounter` once, caching the outcome so repeats send nothing. */
  report(encounter) {
    const existing = this.outcomes.get(encounter.bug);
    if (existing !== undefined) {
      return existing;
    }

    const outcome = this.sendEncounter(encounter);
    this.outcomes.set(encounter.bug, outcome);

    return outcome;
  }

  /** Build and send the Sentry event envelope for `encounter`. */
  async sendEncounter(encounter) {
    if (encounter.bug === 'boss') {
      return {
        referenceId: encounter.stall.traceId ?? 'unavailable',
        delivery: 'unconfirmed',
      };
    }

    const eventId = randomHex(32);
    const envelope =
      encounter.bug === 'weapon'
        ? this.buildEventEnvelope(
            eventId,
            'weapon',
            'WeaponConfigError',
            encounter.jam.error.message,
            toSentryFrames(WEAPON_STACK_FRAMES),
            {
              weapon_state: {
                attemptedWeapon: encounter.jam.weaponId,
                availableWeapons: encounter.jam.availableWeapons,
              },
            },
          )
        : this.buildEventEnvelope(
            eventId,
            'shield',
            'GameLogicError',
            `Shield was active but ${encounter.failure.actualDamage} damage was applied (expected 0). Ship destroyed despite an active shield.`,
            [
              {
                filename: 'game/src/shield/shield.mjs',
                function: 'resolveShieldHit',
                lineno: 14,
                in_app: true,
              },
            ],
            {
              shield_state: { ...encounter.failure },
            },
          );

    const confirmed = await this.postEnvelope(envelope);

    return { referenceId: eventId, delivery: confirmed ? 'confirmed' : 'unconfirmed' };
  }

  /** Build a v2 span item for one child resource load inside `boss-spawn`. */
  buildChildSpanItem(traceId, parentSpanId, name, operation, startSeconds, endSeconds) {
    return {
      name,
      span_id: randomHex(16),
      trace_id: traceId,
      parent_span_id: parentSpanId,
      start_timestamp: startSeconds,
      end_timestamp: endSeconds,
      is_segment: false,
      status: 'ok',
      attributes: {
        'sentry.origin': spanAttribute('manual'),
        'sentry.op': spanAttribute(operation),
        'sentry.trace_lifecycle': spanAttribute('stream'),
        'sentry.segment.name': spanAttribute('boss-spawn'),
        'sentry.segment.id': spanAttribute(parentSpanId),
        'sentry.sdk.name': spanAttribute('sentry.javascript.browser'),
        'sentry.sdk.version': spanAttribute('11.7.0'),
        'sentry.release': spanAttribute(this.identity.release),
        'sentry.environment': spanAttribute(this.settings.environment),
      },
    };
  }

  /** Build the 3-line v2 span envelope for the `boss-spawn` root segment and its child spans. */
  buildSpanEnvelope(traceId, rootSpanId, startSeconds, endSeconds, childItems) {
    const rootItem = {
      name: 'boss-spawn',
      span_id: rootSpanId,
      trace_id: traceId,
      start_timestamp: startSeconds,
      end_timestamp: endSeconds,
      is_segment: true,
      status: 'ok',
      attributes: {
        'sentry.origin': spanAttribute('manual'),
        'sentry.op': spanAttribute('game.boss'),
        'sentry.segment.name.source': spanAttribute('custom'),
        'sentry.sample_rate': spanAttribute(1, 'integer'),
        run_id: spanAttribute(this.identity.attemptId),
        bug: spanAttribute('boss'),
        'sentry.trace_lifecycle': spanAttribute('stream'),
        'sentry.segment.name': spanAttribute('boss-spawn'),
        'sentry.segment.id': spanAttribute(rootSpanId),
        'sentry.sdk.name': spanAttribute('sentry.javascript.browser'),
        'sentry.sdk.version': spanAttribute('11.7.0'),
        'sentry.release': spanAttribute(this.identity.release),
        'sentry.environment': spanAttribute(this.settings.environment),
      },
    };
    const items = [...childItems, rootItem];
    const header = {
      sent_at: new Date().toISOString(),
      trace: {
        environment: this.settings.environment,
        release: this.identity.release,
        public_key: this.parsedDsn.publicKey,
        trace_id: traceId,
        ...(this.parsedDsn.orgId === undefined ? {} : { org_id: this.parsedDsn.orgId }),
        transaction: 'boss-spawn',
        sampled: 'true',
        sample_rate: '1',
      },
      sdk: { name: 'sentry.javascript.browser', version: '11.7.0' },
    };
    const itemHeader = {
      type: 'span',
      item_count: items.length,
      content_type: 'application/vnd.sentry.items.span.v2+json',
    };

    return `${JSON.stringify(header)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify({ version: 2, items })}\n`;
  }

  /** Build the 3-line Sentry error event envelope for `bug`. */
  buildEventEnvelope(eventId, bug, errorType, message, frames, contexts) {
    const header = {
      event_id: eventId,
      sent_at: new Date().toISOString(),
      sdk: { name: 'sentry.javascript.browser', version: '11.7.0' },
      trace: {
        environment: this.settings.environment,
        release: this.identity.release,
        public_key: this.parsedDsn.publicKey,
        trace_id: this.traceId,
        ...(this.parsedDsn.orgId === undefined ? {} : { org_id: this.parsedDsn.orgId }),
      },
    };
    const tags = {
      run_id: this.identity.attemptId,
      bug,
      ...(this.identity.stationId === null ? {} : { station_id: this.identity.stationId }),
      ...(this.identity.sessionId === null ? {} : { boothstrap_session_id: this.identity.sessionId }),
    };
    const payload = {
      event_id: eventId,
      timestamp: Date.now() / 1_000,
      platform: 'javascript',
      level: 'error',
      environment: this.settings.environment,
      release: this.identity.release,
      sdk: { name: 'sentry.javascript.browser', version: '11.7.0' },
      tags,
      fingerprint: ['glitch-invaders', bug],
      contexts: {
        trace: { trace_id: this.traceId, span_id: randomHex(16) },
        ...contexts,
      },
      breadcrumbs: [...this.breadcrumbs],
      exception: {
        values: [
          {
            type: errorType,
            value: message,
            stacktrace: { frames },
            mechanism: { type: 'generic', handled: true },
          },
        ],
      },
    };

    return `${JSON.stringify(header)}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(payload)}\n`;
  }

  /** POST `envelope` to Sentry within `DELIVERY_TIMEOUT_MS`, returning true when accepted. */
  async postEnvelope(envelope) {
    let timer;
    try {
      const request = Promise.resolve(
        this.fetchImpl(this.parsedDsn.envelopeUrl, {
          method: 'POST',
          body: envelope,
        }),
      ).then((response) => Boolean(response?.ok));
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), DELIVERY_TIMEOUT_MS);
      });

      return await Promise.race([request, timeout]);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Live reporting through Sentry's envelope endpoint for the DSN: one real error event for the weapon
 * jam, one for the shield failure, and a transaction trace for the boss spawn, each tagged with the run and
 * the bug. It needs only the public DSN, so no token is ever on the page; the page server reads
 * back what Sentry recorded. No SDK is loaded: the page's CSP allows scripts from itself alone.
 */
import { SHIELD_STACK_FRAMES, WEAPON_STACK_FRAMES } from '../diagnostics/evidence-builders.mjs';

/** How long to wait for Sentry to accept a report. */
export const DELIVERY_TIMEOUT_MS = 2_500;

/** The release every report carries, so Sentry groups them under this challenge. */
const RELEASE = 'glitch-invaders-on-call@1';

/** The SDK name and version reports identify as; Sentry's ingest expects a browser SDK shape. */
const SDK = { name: 'sentry.javascript.browser', version: '11.7.0' };

/** The most breadcrumbs an event carries. */
const MAX_BREADCRUMBS = 40;

/** A lowercase hex string of `length` characters, such as an event or trace id. */
function randomHex(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length / 2));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The envelope endpoint and public key of `dsn`. */
export function parseDsn(dsn) {
  const url = new URL(dsn);
  const projectId = url.pathname.slice(1);
  const query = new URLSearchParams({
    sentry_version: '7',
    sentry_key: url.username,
    sentry_client: `${SDK.name}/${SDK.version}`,
  });

  return {
    publicKey: url.username,
    envelopeUrl: `${url.origin}/api/${projectId}/envelope/?${query}`,
  };
}

/** One envelope: a header line, then an item header and payload line per item. */
function envelope(header, itemHeader, payload) {
  return `${JSON.stringify(header)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify(payload)}\n`;
}

/** Curated frames, innermost first, as Sentry's oldest-first stacktrace frames. */
function toSentryFrames(frames) {
  return frames.toReversed().map((frame) => ({
    filename: frame.file,
    function: frame.functionName,
    lineno: frame.line,
    in_app: frame.inApp,
  }));
}

/** Sends the game's intentional failures to Sentry, once per bug. */
export class SentryReporter {
  /**
   * @param {{ dsn: string }} settings the public Sentry settings.
   * @param {string} attemptId the run every report is tagged with.
   * @param {typeof fetch} fetchImpl
   */
  constructor(settings, attemptId, fetchImpl) {
    this.dsn = parseDsn(settings.dsn);
    this.attemptId = attemptId;
    this.fetchImpl = fetchImpl;
    this.breadcrumbs = [];
    this.reports = new Map();
  }

  /** Record a breadcrumb so the next error event carries the trail. */
  add(breadcrumb) {
    this.breadcrumbs.push({
      timestamp: Date.now() / 1_000,
      category: breadcrumb.category,
      message: breadcrumb.message,
      level: breadcrumb.level ?? 'info',
      ...(breadcrumb.data === undefined ? {} : { data: breadcrumb.data }),
    });
    if (this.breadcrumbs.length > MAX_BREADCRUMBS) {
      this.breadcrumbs.shift();
    }
  }

  /**
   * Report `encounter` once; a repeat resolves with the first outcome and sends nothing.
   *
   * @returns {Promise<{ id: string, delivered: boolean }>} the event id, or the trace id for the
   *   boss, and whether Sentry accepted it. Never rejects.
   */
  report(encounter) {
    const existing = this.reports.get(encounter.bug);
    if (existing !== undefined) {
      return existing;
    }

    const id = randomHex(32);
    const body =
      encounter.bug === 'boss'
        ? this.traceEnvelope(id, encounter.stall)
        : this.eventEnvelope(id, encounter);
    const outcome = this.post(body).then((delivered) => ({ id, delivered }));
    this.reports.set(encounter.bug, outcome);

    return outcome;
  }

  /** The error event envelope for the weapon or shield `encounter`, with id `eventId`. */
  eventEnvelope(eventId, encounter) {
    const isWeapon = encounter.bug === 'weapon';
    const exception = isWeapon
      ? {
          type: 'WeaponConfigError',
          value: encounter.jam.error.message,
          frames: toSentryFrames(WEAPON_STACK_FRAMES),
        }
      : {
          type: 'GameLogicError',
          value: `Shield was active but ${encounter.failure.actualDamage} damage was applied (expected 0). Ship destroyed despite an active shield.`,
          frames: toSentryFrames(SHIELD_STACK_FRAMES),
        };
    const contexts = isWeapon
      ? {
          weapon_state: {
            attemptedWeapon: encounter.jam.weaponId,
            availableWeapons: encounter.jam.availableWeapons,
          },
        }
      : { shield_state: { shieldActive: true, expectedDamage: 0, ...encounter.failure } };

    return envelope(
      { event_id: eventId, sent_at: new Date().toISOString(), sdk: SDK },
      { type: 'event' },
      {
        event_id: eventId,
        timestamp: Date.now() / 1_000,
        platform: 'javascript',
        level: 'error',
        release: RELEASE,
        sdk: SDK,
        tags: { run_id: this.attemptId, bug: encounter.bug },
        fingerprint: ['glitch-invaders', encounter.bug],
        contexts,
        breadcrumbs: [...this.breadcrumbs],
        exception: {
          values: [
            {
              type: exception.type,
              value: exception.value,
              stacktrace: { frames: exception.frames },
              mechanism: { type: 'generic', handled: true },
            },
          ],
        },
      },
    );
  }

  /**
   * The transaction envelope for the boss `stall`: a `boss-spawn` transaction with one child span
   * per load, timed as the run measured them and ending now.
   */
  traceEnvelope(traceId, stall) {
    const eventId = randomHex(32);
    const rootSpanId = randomHex(16);
    const endSeconds = Date.now() / 1_000;
    const startSeconds = endSeconds - stall.totalMs / 1_000;
    const spans = stall.spans.map((span) => ({
      span_id: randomHex(16),
      parent_span_id: rootSpanId,
      trace_id: traceId,
      op: span.operation,
      description: span.name,
      start_timestamp: startSeconds + span.startMs / 1_000,
      timestamp: startSeconds + (span.startMs + span.durationMs) / 1_000,
      status: 'ok',
    }));

    return envelope(
      {
        event_id: eventId,
        sent_at: new Date().toISOString(),
        sdk: SDK,
        trace: {
          public_key: this.dsn.publicKey,
          trace_id: traceId,
          release: RELEASE,
          transaction: 'boss-spawn',
          sampled: 'true',
          sample_rate: '1',
        },
      },
      { type: 'transaction' },
      {
        type: 'transaction',
        event_id: eventId,
        transaction: 'boss-spawn',
        transaction_info: { source: 'custom' },
        start_timestamp: startSeconds,
        timestamp: endSeconds,
        platform: 'javascript',
        release: RELEASE,
        sdk: SDK,
        tags: { run_id: this.attemptId, bug: 'boss' },
        contexts: {
          trace: { trace_id: traceId, span_id: rootSpanId, op: 'game.boss', status: 'ok' },
        },
        spans,
      },
    );
  }

  /** POST `body` to the envelope endpoint, resolving whether Sentry accepted it in time. */
  async post(body) {
    try {
      const response = await this.fetchImpl(this.dsn.envelopeUrl, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}

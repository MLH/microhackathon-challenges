/**
 * Live evidence: what Sentry itself recorded for one of the page's reports, fetched through
 * {@link SentryApi} and reshaped into the sections the Incident Console renders. Everything Sentry
 * returns is untrusted, so each field is checked or turned into plain text here.
 */
import {
  bootStateSection,
  evidenceTitle,
  waterfallSection,
} from '../game/src/diagnostics/evidence-builders.mjs';
import { SentryUnavailableError } from './sentry-api.mjs';

/** How many of the most recent breadcrumbs the console shows. */
const SHOWN_BREADCRUMBS = 8;

/** The context each error event carries, which the console shows as pills. */
const CONTEXT_NAMES = { weapon: 'weapon_state', shield: 'shield_state' };

/** Marks the boss context as the game's own state, since the trace Sentry returns carries none. */
const LOCAL_STATE_CAPTION = 'Local game state, not from Sentry';

/** The breadcrumb levels the console has glyphs for; Sentry's others fold into these. */
const CONSOLE_LEVELS = { info: 'info', warning: 'warning', error: 'error', fatal: 'error' };

/** `value` as display text, with lists joined the way the simulated evidence shows them. */
function text(value) {
  if (Array.isArray(value)) {
    return value.map(String).join(', ');
  }

  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

/** `value` as a finite number, or an outage when Sentry sent something else. */
function finite(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new SentryUnavailableError(`Sentry sent a ${field} that is not a number`);
  }

  return number;
}

/** The `data` of the event entry of `type`, such as `exception` or `breadcrumbs`. */
function entryData(event, type) {
  const entries = Array.isArray(event.entries) ? event.entries : [];

  return entries.find((entry) => entry?.type === type)?.data ?? null;
}

/** `url` when it is an HTTPS link the console may open, else `null`. */
function httpsLink(url) {
  return typeof url === 'string' && URL.parse(url)?.protocol === 'https:' ? url : null;
}

/** Format how long before `lastMs` something happened, such as `-1.2 s`. */
function offsetLabel(lastMs, atMs) {
  const seconds = Math.max(0, lastMs - atMs) / 1_000;

  return seconds < 0.05 ? '0.0 s' : `-${seconds.toFixed(1)} s`;
}

/** The last breadcrumbs of `event`, as console entries timed from the last one. */
function breadcrumbEntries(event) {
  const values = entryData(event, 'breadcrumbs')?.values;
  const crumbs = (Array.isArray(values) ? values : []).slice(-SHOWN_BREADCRUMBS);
  const times = crumbs.map((crumb) => Date.parse(crumb?.timestamp) || 0);
  const lastMs = Math.max(0, ...times);

  return crumbs.map((crumb, index) => {
    const data = Object.entries(crumb?.data ?? {}).map(([key, value]) => [key, text(value)]);

    return {
      offsetLabel: offsetLabel(lastMs, times[index]),
      category: text(crumb?.category ?? 'default'),
      message: text(crumb?.message ?? ''),
      level: CONSOLE_LEVELS[crumb?.level] ?? 'info',
      data: data.length === 0 ? null : Object.fromEntries(data),
    };
  });
}

/** The stack frames of `exception`, innermost first as the console lists them. */
function stackFrames(exception) {
  const frames = Array.isArray(exception.stacktrace?.frames) ? exception.stacktrace.frames : [];

  return frames.toReversed().map((frame) => ({
    functionName: text(frame?.function ?? '?'),
    file: text(frame?.filename ?? '?'),
    line: Number.isInteger(frame?.lineNo) ? frame.lineNo : 0,
    inApp: frame?.inApp === true,
  }));
}

/** The context section `name` of `event`, leaving out the `type` Sentry adds to every context. */
function contextSection(event, name) {
  const { type: _type, ...entries } = event.contexts?.[name] ?? {};

  return {
    kind: 'context',
    title: name,
    contextName: name,
    entries: Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, text(value)])),
  };
}

/** Evidence for the weapon or shield failure: its event and the issue Sentry grouped it into. */
async function errorEvidence(api, bug, eventId, signal) {
  const event = await api.event(eventId, signal);
  const exception = entryData(event, 'exception')?.values?.at(-1);
  if (exception === undefined || exception === null) {
    throw new SentryUnavailableError(`Sentry's event ${eventId} has no exception`);
  }
  const issue = await api.issue(text(event.groupID), signal);
  const permalink = httpsLink(issue.permalink);
  const primary =
    bug === 'weapon'
      ? { kind: 'stacktrace', title: 'Stack trace', frames: stackFrames(exception) }
      : { kind: 'breadcrumbs', title: 'Breadcrumbs', entries: breadcrumbEntries(event) };

  return {
    bug,
    source: 'live',
    title: text(issue.title ?? event.title),
    referenceId: text(issue.shortId ?? eventId),
    sections: [
      {
        kind: 'exception',
        title: 'Exception',
        errorType: text(exception.type ?? 'Error'),
        message: text(exception.value ?? ''),
      },
      primary,
      contextSection(event, CONTEXT_NAMES[bug]),
    ],
    link: permalink === null ? null : { label: 'Open the issue in Sentry', url: permalink },
  };
}

/** Evidence for the boss stall: the boss-spawn trace's load spans, as Sentry indexed them. */
async function bossEvidence(api, traceId, signal) {
  const rows = await api.traceSpans(traceId, signal);
  const starts = rows.map((row) => finite(row['precise.start_ts'], 'span start'));
  const firstStart = Math.min(...starts);
  const spans = rows.map((row, index) => ({
    name: text(row['span.description']),
    operation: text(row['span.op']),
    startMs: Math.round((starts[index] - firstStart) * 1_000),
    durationMs: Math.round(finite(row['span.duration'], 'span duration')),
  }));
  const waterfall = waterfallSection(spans);
  const traceUrl = `https://${encodeURIComponent(api.org)}.sentry.io/explore/traces/trace/${traceId}/`;

  return {
    bug: 'boss',
    source: 'live',
    title: evidenceTitle({ bug: 'boss', stall: { totalMs: waterfall.totalMs } }),
    referenceId: `trace ${traceId.slice(0, 8)}`,
    sections: [waterfall, { ...bootStateSection(), caption: LOCAL_STATE_CAPTION }],
    link: { label: 'Open the trace in Sentry', url: traceUrl },
  };
}

/**
 * Fetch the live evidence for the page's report `id` of `bug`: an event id for the weapon and
 * shield, a trace id for the boss. Every request and wait stops once `signal` aborts.
 *
 * @throws {SentryUnavailableError} when Sentry is down, slow to index, past the deadline, or answers
 *   with nonsense.
 */
export function fetchLiveEvidence(api, bug, id, signal) {
  return bug === 'boss' ? bossEvidence(api, id, signal) : errorEvidence(api, bug, id, signal);
}

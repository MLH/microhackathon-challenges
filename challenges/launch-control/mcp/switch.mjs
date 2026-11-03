/**
 * `switch_travel_agent`: move this session's travel booker one rung up the ladder, or back to v1.
 * It changes only this session's individual target on the booker's config, through the REST API,
 * and then waits for the page to show the new rung, so the guide can point at the config card.
 */
import { sleep } from '../server/http.mjs';
import { rungByKey, rungByNumber } from '../server/ladder.mjs';

/** How long the tool waits for the page to show the new rung. */
const PAGE_WAIT_MS = 6_000;

/** How often it checks the page meanwhile. */
const PAGE_POLL_MS = 150;

/** A switch the tool refuses; the message says what to do instead. */
export class SwitchRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SwitchRefusedError';
  }
}

/** The rung the page server shows now, or `null` when it does not answer. */
async function pageRung(pagePort) {
  try {
    const response = await fetch(`http://127.0.0.1:${pagePort}/api/state`, { signal: AbortSignal.timeout(1_000) });
    const state = await response.json();

    return state.config?.rung ?? null;
  } catch {
    return null;
  }
}

/**
 * Decide whether moving from `current` to `requested` is allowed.
 *
 * @returns {ReturnType<typeof rungByNumber>} the requested rung.
 * @throws {SwitchRefusedError} for a skip, a step down other than to v1, the current rung, or a
 *   rung the ladder does not have, saying which rung is next.
 */
export function checkSwitch(ladder, current, requested) {
  const target = Number.isInteger(requested) ? rungByNumber(ladder, requested) : undefined;
  const last = ladder.rungs.length;
  const next = rungByNumber(ladder, current + 1);
  const nextHint = next === undefined ? `v${current} is the top rung; the only switch left is 1, the rollback.` : `The next rung is ${next.rung}: ${next.adds} Call switch_travel_agent with rung ${next.rung}.`;
  if (target === undefined) {
    throw new SwitchRefusedError(`rung must be a whole number from 1 to ${last}. ${nextHint}`);
  }
  if (target.rung === current) {
    throw new SwitchRefusedError(`The booker is already on ${target.name}. ${nextHint}`);
  }
  if (target.rung !== current + 1 && target.rung !== 1) {
    throw new SwitchRefusedError(`Rungs go one at a time, so ${target.name} is not next. ${nextHint}`);
  }

  return target;
}

/**
 * Switch this session's booker to `requested`.
 *
 * @param {{ ladder: object, api: import('../server/launchdarkly-api.mjs').LaunchDarklyApi,
 *   sessionKey: string, pagePort: number }} context
 * @returns {Promise<string>} what changed, for the guide to relay.
 * @throws {SwitchRefusedError} for a switch the ladder does not allow.
 * @throws {import('../server/launchdarkly-api.mjs').LaunchDarklyApiError} when LaunchDarkly fails.
 */
export async function switchTravelAgent(context, requested) {
  const { targetOf } = await context.api.readTargeting();
  const currentKey = targetOf(context.sessionKey);
  const targeted = currentKey === null ? rungByNumber(context.ladder, 1) : rungByKey(context.ladder, currentKey);
  if (targeted === undefined) {
    throw new SwitchRefusedError(`This session is targeted to ${currentKey}, which is not on the ladder; run provision.mjs.`);
  }
  const current = targeted.rung;
  const target = checkSwitch(context.ladder, current, requested);

  await context.api.targetSession(context.sessionKey, target.key);

  const deadline = Date.now() + PAGE_WAIT_MS;
  let shown = await pageRung(context.pagePort);
  while (shown !== target.rung && Date.now() < deadline) {
    await sleep(PAGE_POLL_MS);
    shown = await pageRung(context.pagePort);
  }
  const tools = target.tools.length === 0 ? 'no tools' : `tools ${target.tools.join(', ')}`;
  const page =
    shown === target.rung
      ? 'The config card on the page shows it now, with no reload and no deploy.'
      : 'LaunchDarkly has the change; the page will show it within a few seconds.';

  return `Switched this session's travel booker to ${target.name}: ${target.model}, ${tools}. ${page}`;
}

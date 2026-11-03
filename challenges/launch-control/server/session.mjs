/**
 * One attempt's travel-desk session: the chat history the page shows, the rungs the participant
 * has sent a request on, whether the top rung booked a trip, and the page state line the monitor
 * reads. A rung counts as tried only once the booker answered a message sent while it was live.
 */

/** The page state line's fixed prefix and version, which the monitor skill matches. */
export const STATE_LINE_PREFIX = 'booker-state v1';

/**
 * The page state line, in the coarse words the monitor matches exactly, for example
 * `booker-state v1 rung=2 tried=1,2 booked=no mode=demo`.
 */
export function stateLine({ rung, tried, booked, mode }) {
  const triedWords = tried.length === 0 ? 'none' : tried.join(',');

  return `${STATE_LINE_PREFIX} rung=${rung ?? 'none'} tried=${triedWords} booked=${booked ? 'yes' : 'no'} mode=${mode}`;
}

/** The booker's chat with one participant, across every rung. */
export class TravelDeskSession {
  /**
   * @param {'live' | 'demo'} mode
   * @param {ReturnType<typeof import('./ladder.mjs').parseLadder>} ladder
   */
  constructor(mode, ladder) {
    this.mode = mode;
    this.rungs = ladder.rungs.map(({ rung, name }) => ({ rung, name }));
    this.topRung = ladder.rungs.at(-1).rung;
    this.messages = [];
    this.tried = new Set();
    this.booking = null;
    this.topRungBooked = false;
    this.conversation = { variationKey: null, contents: [] };
  }

  /**
   * The model conversation for `config`. A new rung starts a fresh one, so each rung answers the
   * request on its own; the page keeps showing the whole history.
   */
  conversationFor(config) {
    if (this.conversation.variationKey !== config.variationKey) {
      this.conversation = { variationKey: config.variationKey, contents: [] };
    }

    return this.conversation.contents;
  }

  /** Record one answered exchange on `config`. */
  recordExchange(config, message, result) {
    this.messages.push({ role: 'participant', text: message, rung: config.rung });
    this.messages.push({
      role: 'booker',
      text: result.reply,
      rung: config.rung,
      name: config.name,
      model: config.model,
      toolCalls: result.toolCalls,
      ...(result.booking === null ? {} : { booking: result.booking }),
    });
    this.tried.add(config.rung);
    if (result.booking !== null) {
      this.booking = result.booking;
      this.topRungBooked ||= config.rung === this.topRung;
    }
  }

  /** Record a message the booker could not answer, so the participant sees why. */
  recordFailure(config, message, reason) {
    this.messages.push({ role: 'participant', text: message, rung: config?.rung ?? null });
    this.messages.push({ role: 'error', text: reason, rung: config?.rung ?? null });
  }

  /**
   * What the page, the monitor, and the guide see, for `config` (or `null` when unavailable).
   * `booked` is whether the top rung booked a trip, which is what `add-model` turns on; `booking`
   * is the latest booking on any rung, for the page to show.
   */
  snapshot(config) {
    const tried = [...this.tried].sort((left, right) => left - right);

    return {
      mode: this.mode,
      config:
        config === null
          ? null
          : {
              rung: config.rung,
              name: config.name,
              variationKey: config.variationKey,
              model: config.model,
              promptExcerpt: config.promptExcerpt,
              tools: config.tools.map((tool) => tool.name),
            },
      tried,
      rungs: this.rungs,
      booked: this.topRungBooked,
      booking: this.booking,
      stateLine: stateLine({ rung: config?.rung ?? null, tried, booked: this.topRungBooked, mode: this.mode }),
    };
  }
}

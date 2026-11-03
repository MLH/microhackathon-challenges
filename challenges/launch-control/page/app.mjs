/**
 * The travel desk page: a chat with the booker, and a card showing the config LaunchDarkly serves
 * this session. It polls the page server for the config, so a switch shows in place with no
 * reload, and mirrors the server's state line into the hidden page state signal the monitor reads.
 * Model output is only ever set as text, never parsed as HTML.
 */

/** How often the page asks for the live config. */
const POLL_MS = 1_000;

/** The ladder's rungs, `{ rung, name }`, as the server last sent them. */
let rungs = [];

/** The name the ladder gives rung `number`, such as `v2 · prompted`. */
function rungName(number) {
  return rungs.find((candidate) => candidate.rung === number)?.name ?? `v${number}`;
}

/** Look up an element by id. */
const byId = (id) => document.getElementById(id);

/** Create an element with a class and text. */
function element(tag, className, text) {
  const created = document.createElement(tag);
  if (className !== undefined) {
    created.className = className;
  }
  if (text !== undefined) {
    created.textContent = text;
  }

  return created;
}

/** A model reply as plain text, with Markdown's bold markers removed. */
function plainText(text) {
  return text.replace(/\*\*/g, '');
}

/** A one-line summary of a booking for the chat and the card. */
function bookingSummary(booking) {
  return `${booking.confirmation}: ${booking.outbound.airline} ${booking.outbound.id} and ${booking.return.id}, ${booking.hotel.name}, ${booking.nights} nights, $${booking.total_usd} total.`;
}

/** Draw one chat message. */
function renderMessage(message) {
  const item = element('li', `message message-${message.role}`);
  if (message.role === 'booker') {
    item.append(element('span', 'rung-tag', `${message.name} · ${message.model}`));
  }
  item.append(element('p', 'message-text', plainText(message.text)));
  if (message.toolCalls?.length > 0) {
    const calls = element('ul', 'tool-calls');
    for (const call of message.toolCalls) {
      calls.append(element('li', 'tool-call', call));
    }
    item.append(calls);
  }
  if (message.booking !== undefined) {
    item.append(element('p', 'booking-line', `Booked ${bookingSummary(message.booking)}`));
  }

  return item;
}

/** Redraw the whole chat, with a divider wherever the rung changed between replies. */
function renderMessages(messages) {
  const list = byId('messages');
  const items = [];
  let lastRung = null;
  for (const message of messages) {
    if (message.role === 'participant' && message.rung !== null && message.rung !== lastRung) {
      items.push(element('li', 'divider', `Now on ${rungName(message.rung)}`));
      lastRung = message.rung;
    }
    items.push(renderMessage(message));
  }
  list.replaceChildren(...items);
  list.lastElementChild?.scrollIntoView({ block: 'end' });
}

/** Draw the ladder strip: each rung, marking the live one and the ones tried. */
function renderLadder(state) {
  const items = state.rungs.map(({ rung, name }) => {
    const live = state.config?.rung === rung;
    const tried = state.tried.includes(rung);
    const item = element('li', `rung${live ? ' rung-live' : ''}${tried ? ' rung-tried' : ''}`, name);
    if (live) {
      item.setAttribute('aria-current', 'true');
    }

    return item;
  });
  byId('ladder').replaceChildren(...items);
}

/** The variation last drawn, so a change can flash the card. */
let shownVariation;

/** Draw the live config card, the booking, the demo label, and the state signal. */
function renderState(state) {
  rungs = state.rungs;
  byId('mode-label').hidden = state.mode !== 'demo';
  renderLadder(state);
  const config = state.config;
  byId('config-variation').textContent = config?.name ?? 'No config from LaunchDarkly';
  byId('config-model').textContent = config?.model ?? '—';
  byId('config-prompt').textContent = config?.promptExcerpt ?? '—';
  byId('config-tools').textContent = config === null ? '—' : config.tools.length === 0 ? 'none' : config.tools.join(', ');
  if (shownVariation !== undefined && shownVariation !== config?.variationKey) {
    const card = byId('config-card');
    card.classList.remove('config-changed');
    void card.offsetWidth;
    card.classList.add('config-changed');
  }
  shownVariation = config?.variationKey;

  byId('booking').hidden = state.booking === null;
  if (state.booking !== null) {
    byId('booking-summary').textContent = bookingSummary(state.booking);
  }
  const signal = byId('boothstrap-state');
  if (signal.textContent !== state.stateLine) {
    signal.textContent = state.stateLine;
  }
}

/** Fetch the live state and draw it; a failed poll leaves the page as it was. */
async function refreshState() {
  try {
    const response = await fetch('/api/state');
    if (response.ok) {
      renderState(await response.json());
    }
  } catch {
    return;
  }
}

/** Send the composer's message and draw the answer. */
async function sendMessage(event) {
  event.preventDefault();
  const input = byId('message');
  const message = input.value.trim();
  if (message === '') {
    return;
  }

  byId('send').disabled = true;
  byId('thinking').hidden = false;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    if (response.ok) {
      const state = await response.json();
      input.value = '';
      renderMessages(state.messages);
      renderState(state);
    } else {
      renderMessages([...(await loadHistory()), { role: 'error', text: await response.text(), rung: null }]);
    }
  } finally {
    byId('send').disabled = false;
    byId('thinking').hidden = true;
  }
}

/** The chat so far, from the server, so a reload keeps it. */
async function loadHistory() {
  const response = await fetch('/api/history');

  return response.ok ? (await response.json()).messages : [];
}

/** Wire up the page. */
async function start() {
  byId('composer').addEventListener('submit', sendMessage);
  byId('suggestion').addEventListener('click', () => {
    const input = byId('message');
    input.value = byId('suggestion').textContent.trim();
    input.focus();
  });
  byId('message').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      byId('composer').requestSubmit();
    }
  });

  await refreshState();
  renderMessages(await loadHistory());
  setInterval(refreshState, POLL_MS);
}

start();

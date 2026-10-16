import { BUG_DEFINITIONS, BUG_ORDER } from '../bugs/bug-definitions.mjs';

import { h, replaceChildren, setText } from './dom.mjs';
import { currentObjective } from './objective.mjs';

/** The glyph and word that show a failure's stage; never color alone. */
const STAGE_LABELS = {
  unseen: { glyph: '○', word: 'Not seen' },
  encountered: { glyph: '▶', word: 'Open' },
  investigated: { glyph: '◐', word: 'Diagnosed' },
  repaired: { glyph: '✓', word: 'Fixed' },
};

/** Find a required element by id. */
function requireElement(id) {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`the page has no #${id} element`);
  }

  return element;
}

/** Updates the HUD from the world and progress. */
export class Hud {
  hull = requireElement('stat-hull');
  shield = requireElement('stat-shield');
  kills = requireElement('stat-kills');
  score = requireElement('stat-score');
  badge = requireElement('mode-badge');
  objectiveText = requireElement('objective-text');
  objectiveDetail = requireElement('objective-detail');
  incidents = requireElement('incidents');
  chipSignature = '';

  /** Show the mode badge once; it never changes during a run. */
  showMode(mode, degraded) {
    this.badge.dataset.mode = mode;
    if (mode === 'demo') {
      setText(this.badge, 'DEMO · simulated evidence');
      this.badge.title = 'No Sentry credentials: the diagnostics are realistic simulations.';
    } else {
      setText(this.badge, degraded ? 'LIVE · Sentry unreachable' : 'LIVE · Sentry');
      this.badge.title = 'Real errors, breadcrumbs, and traces are sent to Sentry.';
    }
  }

  /** Refresh every stat from the latest world and progress. */
  update(progress, world) {
    const hullText = world.player.restoreAt === null ? '♥'.repeat(world.player.hull) : '✖';
    setText(this.hull, hullText === '' ? '✖' : hullText);
    setText(this.shield, world.player.shield ? 'ON' : 'off');
    this.shield.dataset.state = world.player.shield ? 'on' : 'off';
    setText(this.kills, String(world.kills));
    setText(this.score, String(progress.score));

    const objective = currentObjective(progress, world);
    setText(this.objectiveText, objective.text);
    setText(this.objectiveDetail, objective.detail);
    this.renderChips(progress);
  }

  /** Redraw the incident chips only when a stage changed. */
  renderChips(progress) {
    const signature = BUG_ORDER.map((bug) => progress.bugs[bug].stage).join('|');
    if (signature === this.chipSignature) {
      return;
    }
    this.chipSignature = signature;
    replaceChildren(this.incidents, ...BUG_ORDER.map((bug) => chip(bug, progress.bugs[bug].stage)));
  }
}

/** One incident chip. */
function chip(bug, stage) {
  const label = STAGE_LABELS[stage];
  const definition = BUG_DEFINITIONS[bug];
  const title = stage === 'unseen' ? '' : ` ${definition.title}`;

  return h(
    'li',
    { class: 'chip', 'data-stage': stage, 'data-bug': bug },
    h('span', { class: 'chip-glyph', 'aria-hidden': 'true' }, label.glyph),
    `${definition.incidentLabel}${title} `,
    h('span', { class: 'chip-word' }, label.word),
  );
}

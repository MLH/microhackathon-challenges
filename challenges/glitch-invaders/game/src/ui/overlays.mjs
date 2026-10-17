import { BUG_DEFINITIONS, BUG_ORDER } from '../bugs/bug-definitions.mjs';
import { focusableElements, h, onClick } from './dom.mjs';

/** The page regions that become inert behind a modal card. */
const BACKGROUND_IDS = ['topbar', 'stage-wrap', 'dock'];

/** Shows one modal card at a time. */
export class OverlayHost {
  root;
  opener = null;

  constructor(root) {
    this.root = root;
  }

  /** Whether a card is showing. */
  get isOpen() {
    return !this.root.hidden;
  }

  /** The card showing now, if any. */
  get current() {
    return this.isOpen ? this.root.firstElementChild : null;
  }

  /** Show `content` as the only card, focusing its `data-autofocus` control or its first control. */
  show(content) {
    if (!this.isOpen) {
      this.opener = document.activeElement;
    }
    this.root.replaceChildren(content);
    this.root.hidden = false;
    for (const id of BACKGROUND_IDS) {
      document.getElementById(id)?.setAttribute('inert', '');
    }
    const target = content.querySelector('[data-autofocus]') ?? focusableElements(content)[0];
    target?.focus();
  }

  /** Close the card and return focus to where it was, or to `fallback`. */
  hide(fallback) {
    if (!this.isOpen) {
      return;
    }
    this.root.hidden = true;
    this.root.replaceChildren();
    for (const id of BACKGROUND_IDS) {
      document.getElementById(id)?.removeAttribute('inert');
    }
    const target = fallback ?? this.opener;
    this.opener = null;
    target?.focus();
  }
}

/** Wrap card contents in the standard centered card. */
function card(title, label, ...children) {
  return h(
    'section',
    { class: 'card overlay-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': label },
    h('h2', { class: 'card-title', id: label }, title),
    ...children,
  );
}

/** The briefing shown before play, or the welcome-back card after a refresh. */
export function introCard(options) {
  return card(
    options.returning ? 'Welcome back' : 'Incident briefing',
    'intro-title',
    h('p', { class: 'hero' }, 'Glitch Invaders: ', h('em', {}, 'On-Call')),
    h(
      'p',
      { class: 'lede' },
      options.returning
        ? 'Your run is saved. Pick up where you left off.'
        : 'Production is crawling with glitches. You are the patch drone. Shoot, grab upgrades, and when something breaks, find out why and fix it.',
    ),
    h(
      'ul',
      { class: 'keys', 'aria-label': 'Controls' },
      h(
        'li',
        {},
        h('kbd', {}, '◀'),
        ' ',
        h('kbd', {}, '▶'),
        ' or ',
        h('kbd', {}, 'A'),
        ' ',
        h('kbd', {}, 'D'),
        ' move',
      ),
      h('li', {}, h('kbd', {}, 'Space'), ' fires'),
      h('li', {}, h('kbd', {}, 'P'), ' pauses'),
    ),
    h('p', { class: 'muted' }, 'Demo mode: the diagnostics are realistic simulations.'),
    onClick(
      h(
        'button',
        { type: 'button', class: 'button button-primary button-large', 'data-autofocus': true },
        options.returning ? 'Resume ▶' : 'Start ▶',
      ),
      options.onStart,
    ),
  );
}

/** The pause card. */
export function pauseCard(onResume) {
  return card(
    'Paused',
    'pause-title',
    h('p', { class: 'lede' }, 'The arena is frozen. Take your time.'),
    onClick(
      h(
        'button',
        { type: 'button', class: 'button button-primary button-large', 'data-autofocus': true },
        'Resume ▶',
      ),
      onResume,
    ),
  );
}

/** The recap shown once all three incidents are closed. */
export function completionCard(progress, onContinue, onReset) {
  return card(
    '✓ All incidents closed',
    'done-title',
    h('p', { class: 'hero' }, `Score ${progress.score}`),
    h(
      'ul',
      { class: 'recap', 'aria-label': 'What you fixed' },
      ...BUG_ORDER.map((bug) => {
        const definition = BUG_DEFINITIONS[bug];

        return h(
          'li',
          {},
          h('strong', {}, `${definition.incidentLabel} ${definition.title}`),
          h('span', { class: 'lens' }, ` ${definition.lens}`),
          h('span', { class: 'recap-text' }, definition.fixExplanation),
        );
      }),
    ),
    onContinue || onReset
      ? h(
          'div',
          { class: 'card-actions' },
          onContinue
            ? onClick(
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'button button-primary button-large',
                    'data-autofocus': true,
                    'data-key': 'continue-playing',
                  },
                  'Continue Playing ▶',
                ),
                onContinue,
              )
            : null,
          onReset
            ? onClick(
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'button button-large',
                    'data-key': 'reset-run',
                  },
                  'Start New Run ↺',
                ),
                onReset,
              )
            : null,
        )
      : null,
  );
}

import { BUG_DEFINITIONS } from '../bugs/bug-definitions.mjs';
import { REPAIR_PATCHES } from '../bugs/code-state.mjs';

import { BOSS_SPAWN_BUDGET_MS, SCORE_HINT_COST } from '../engine/constants.mjs';
import { focusableElements, h, onClick, trapFocus } from './dom.mjs';

/** The words that describe where the evidence came from, shown as a badge. */
const SOURCE_BADGES = {
  simulated: {
    label: 'DEMO · SIMULATED',
    note: 'Demo mode: realistic diagnostics, no Sentry account needed.',
  },
  live: { label: 'LIVE SENTRY', note: 'Captured by the game and delivered to Sentry.' },
  'live-unconfirmed': {
    label: 'LIVE · LOCAL COPY',
    note: 'Sentry could not confirm delivery. This is the game’s own capture of what it sent.',
  },
};

/** The glyphs for breadcrumb levels; level is never color alone. */
const LEVEL_GLYPHS = {
  info: '●',
  warning: '▲',
  error: '✖',
};

/** The console dialog. */
export class IncidentConsole {
  element;
  host;
  bug = 'weapon';
  pane = 'evidence';
  evidence = null;
  diagnosisFeedback = '';
  patchObservation = null;

  constructor(host) {
    this.host = host;
    this.element = h('div', { class: 'console-host' });
    this.element.addEventListener('keydown', (event) => trapFocus(this.element, event));
  }

  /** Open the console for `bug`, showing a capture-in-progress state until evidence arrives. */
  open(bug) {
    this.bug = bug;
    this.evidence = null;
    this.diagnosisFeedback = '';
    this.patchObservation = null;
    const stage = this.host.progressOf(bug).stage;
    this.pane = stage === 'investigated' ? 'patch' : 'evidence';
    this.render();
  }

  /** Evidence arrived for the open failure; all sections are shown together on one card. */
  showEvidence(evidence) {
    if (evidence.bug !== this.bug) {
      return;
    }
    this.evidence = evidence;
    if (!this.host.progressOf(this.bug).evidenceViewed) {
      this.host.markEvidenceViewed(this.bug);
    }
    this.render();
  }

  /** The failure whose console is open. */
  openBug() {
    return this.bug;
  }

  /** Put keyboard focus on the first useful control. */
  focusFirst() {
    const selected = this.element.querySelector('[role="tab"][aria-selected="true"]');
    (selected ?? focusableElements(this.element)[0])?.focus();
  }

  /** Rebuild the dialog, keeping keyboard focus on the same control. */
  render() {
    const focusKey = document.activeElement?.dataset?.key ?? null;
    const definition = BUG_DEFINITIONS[this.bug];
    const progress = this.host.progressOf(this.bug);
    const badge = this.evidence === null ? null : SOURCE_BADGES[this.evidence.source];

    const dialog = h(
      'section',
      {
        class: 'card console',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'console-title',
      },
      h(
        'header',
        { class: 'console-header' },
        h(
          'div',
          { class: 'console-heading' },
          h(
            'div',
            { class: 'console-badges' },
            h('span', { class: 'incident-pill' }, definition.incidentLabel),
            h('span', { class: 'lens' }, definition.lens),
            badge === null
              ? null
              : h(
                  'span',
                  {
                    class: 'source-badge',
                    'data-source': this.evidence?.source,
                    title: badge.note,
                  },
                  badge.label,
                ),
          ),
          h('h2', { class: 'console-title', id: 'console-title' }, definition.title),
          h('p', { class: 'console-symptom' }, definition.symptom),
        ),
        this.tabs(progress),
      ),
      h(
        'div',
        { class: 'pane', role: 'tabpanel', 'aria-labelledby': `tab-${this.pane}` },
        this.paneBody(progress),
      ),
    );

    this.element.replaceChildren(dialog);
    if (focusKey !== null) {
      this.element.querySelector(`[data-key="${focusKey}"]`)?.focus();
    }
  }

  /** The step pill strip, with later panes locked until earlier ones are done. */
  tabs(progress) {
    const unlocked = {
      evidence: true,
      diagnose: progress.evidenceViewed,
      patch: progress.stage === 'investigated' || progress.stage === 'repaired',
    };
    const labels = [
      ['evidence', '1. Evidence'],
      ['diagnose', '2. Diagnose'],
      ['patch', '3. Patch'],
    ];

    return h(
      'div',
      { class: 'tabs', role: 'tablist', 'aria-label': 'Investigation steps' },
      ...labels.map(([pane, label]) => {
        const button = h(
          'button',
          {
            type: 'button',
            class: 'tab',
            role: 'tab',
            id: `tab-${pane}`,
            'data-key': `tab-${pane}`,
            'aria-selected': String(this.pane === pane),
            'aria-disabled': unlocked[pane] ? undefined : 'true',
          },
          unlocked[pane] ? label : `${label} · locked`,
        );

        return onClick(button, () => {
          if (!unlocked[pane]) {
            return;
          }
          this.pane = pane;
          this.render();
        });
      }),
    );
  }

  /** The body for the selected pane. */
  paneBody(progress) {
    switch (this.pane) {
      case 'evidence':
        return this.evidencePane();
      case 'diagnose':
        return this.diagnosePane(progress);
      case 'patch':
        return this.patchPane(progress);
    }
  }

  /** Evidence step: in Live mode, directs the participant to Sentry; in Demo mode, shows simulated capture. */
  evidencePane() {
    const evidence = this.evidence;
    if (evidence === null) {
      return h(
        'p',
        { class: 'status', role: 'status' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }, '◌'),
        ' Transmitting telemetry to Sentry…',
      );
    }

    if (evidence.link !== null) {
      return h(
        'div',
        { class: 'evidence' },
        this.sentryHero(evidence),
        renderSentryBriefing(evidence),
        h(
          'div',
          { class: 'pane-actions' },
          h(
            'span',
            { class: 'muted' },
            `${evidence.bug === 'boss' ? 'Trace' : 'Event'} ${evidence.referenceId} · transmitted to Sentry`,
          ),
          h('span', { class: 'spacer' }),
          onClick(
            h(
              'button',
              { type: 'button', class: 'button', 'data-key': 'to-diagnose' },
              'Continue to Diagnose ▶',
            ),
            () => {
              this.pane = 'diagnose';
              this.render();
            },
          ),
        ),
      );
    }

    const contextSection = evidence.sections.find((section) => section.kind === 'context');
    const primarySection = evidence.sections.find(
      (section) =>
        section.kind === 'stacktrace' ||
        section.kind === 'breadcrumbs' ||
        section.kind === 'waterfall',
    );

    return h(
      'div',
      { class: 'evidence' },
      this.sentryHero(evidence),
      contextSection === undefined ? null : renderContextPills(contextSection),
      primarySection === undefined ? null : renderSection(primarySection),
      h(
        'div',
        { class: 'pane-actions' },
        h('span', { class: 'muted' }, `Ref: ${evidence.referenceId}`),
        h('span', { class: 'spacer' }),
        onClick(
          h(
            'button',
            { type: 'button', class: 'button button-primary', 'data-key': 'to-diagnose' },
            'Continue to Diagnose ▶',
          ),
          () => {
            this.pane = 'diagnose';
            this.render();
          },
        ),
      ),
    );
  }

  /** Hero banner with the exception/trace headline and the primary "Investigate in Sentry" CTA. */
  sentryHero(evidence) {
    const isTrace = evidence.bug === 'boss';
    const subtitle =
      evidence.link !== null
        ? isTrace
          ? 'Performance telemetry has been sent to Sentry. Open the trace in Sentry in a new tab, then return here to submit your findings.'
          : 'Telemetry has been sent to Sentry. Open the issue in Sentry in a new tab to investigate, then return here to submit your findings.'
        : 'Demo mode (Sentry not connected): inspect the simulated telemetry snapshot to identify the root cause.';

    const sentryLink =
      evidence.link === null
        ? null
        : h(
            'a',
            {
              class: 'button button-sentry',
              href: evidence.link.url,
              target: '_blank',
              rel: 'noopener',
              'data-key': 'open-sentry',
            },
            `🔍 ${evidence.link.label} ↗`,
          );

    if (sentryLink !== null) {
      sentryLink.addEventListener('click', () => {
        this.pane = 'diagnose';
        this.render();
      });
    }

    return h(
      'div',
      { class: 'sentry-callout' },
      h(
        'div',
        { class: 'sentry-callout-main' },
        h('p', { class: 'evidence-head' }, evidence.title),
        h('p', { class: 'sentry-callout-copy' }, subtitle),
      ),
      sentryLink,
    );
  }

  /** Diagnosis: lettered answer cards, clear feedback, and hints. */
  diagnosePane(progress) {
    const definition = BUG_DEFINITIONS[this.bug];
    const solved = progress.stage === 'investigated' || progress.stage === 'repaired';
    const hints = definition.hints.slice(0, progress.hintsUsed);
    const nextHint = progress.hintsUsed < definition.hints.length;

    return h(
      'div',
      { class: 'diagnose' },
      this.evidence !== null && this.evidence.link !== null
        ? h(
            'div',
            { class: 'sentry-callout sentry-callout-compact' },
            h(
              'span',
              { class: 'sentry-callout-copy' },
              'Need another look at the event in Sentry? Refresh the Sentry tab if spans are still indexing.',
            ),
            h(
              'a',
              {
                class: 'button button-sentry',
                href: this.evidence.link.url,
                target: '_blank',
                rel: 'noopener',
                'data-key': 'open-sentry-diagnose',
              },
              `🔍 ${this.evidence.link.label} ↗`,
            ),
          )
        : null,
      h('p', { class: 'question' }, definition.question),
      h(
        'div',
        { class: 'options', role: 'group', 'aria-label': definition.question },
        ...definition.options.map((option, index) => {
          const letter = String.fromCharCode(65 + index);
          const isSolvedCorrect = solved && option.correct;
          const button = h(
            'button',
            {
              type: 'button',
              class: 'option',
              'data-key': `option-${option.id}`,
              disabled: solved && !option.correct,
              'data-correct': isSolvedCorrect ? 'true' : undefined,
            },
            h(
              'span',
              { class: 'option-letter', 'aria-hidden': 'true' },
              isSolvedCorrect ? '✓' : letter,
            ),
            h('span', { class: 'option-text' }, option.text),
          );

          return onClick(button, () => this.answer(option.id));
        }),
      ),
      this.diagnosisFeedback === ''
        ? null
        : h(
            'p',
            { class: 'feedback feedback-danger', role: 'alert' },
            `✖ ${this.diagnosisFeedback}`,
          ),
      solved
        ? h('p', { class: 'feedback feedback-success', role: 'status' }, '✓ Root cause confirmed.')
        : null,
      hints.length === 0
        ? null
        : h(
            'ol',
            { class: 'hints', 'aria-label': 'Hints' },
            ...hints.map((hint) => h('li', {}, hint)),
          ),
      h(
        'div',
        { class: 'pane-actions' },
        solved || !nextHint
          ? null
          : onClick(
              h(
                'button',
                { type: 'button', class: 'button', 'data-key': 'hint' },
                `💡 Reveal Hint ${progress.hintsUsed + 1} (−${SCORE_HINT_COST} pts)`,
              ),
              () => {
                this.host.useHint(this.bug);
                this.render();
              },
            ),
        h('span', { class: 'spacer' }),
        solved
          ? onClick(
              h(
                'button',
                { type: 'button', class: 'button button-primary', 'data-key': 'to-patch' },
                'Choose a patch ▶',
              ),
              () => {
                this.pane = 'patch';
                this.render();
              },
            )
          : null,
      ),
    );
  }

  /** Submit a diagnosis; a right one moves on to the patch pane. */
  answer(optionId) {
    const result = this.host.diagnose(this.bug, optionId);
    this.diagnosisFeedback = result.feedback;
    if (result.correct) {
      this.pane = 'patch';
    }
    this.render();
  }

  /** Patches: responsive 3-column grid of code patch cards. Wrong ones fail visibly and revert. */
  patchPane(progress) {
    if (progress.stage !== 'investigated') {
      return h('p', { class: 'status' }, 'Diagnose the failure to unlock patches.');
    }

    return h(
      'div',
      { class: 'patches' },
      h(
        'p',
        { class: 'question' },
        'Choose a code patch to test in the arena. A wrong patch reverts itself.',
      ),
      h(
        'div',
        { class: 'patch-grid' },
        ...REPAIR_PATCHES[this.bug].map((patch) => {
          const failed = this.patchObservation?.patchId === patch.id;
          const apply = onClick(
            h(
              'button',
              { type: 'button', class: 'button button-primary', 'data-key': `apply-${patch.id}` },
              'Apply & Test Patch ▶',
            ),
            () => this.apply(patch.id),
          );

          return h(
            'article',
            { class: 'patch', 'data-failed': failed ? 'true' : undefined },
            h(
              'div',
              { class: 'patch-body' },
              h('h3', { class: 'patch-title' }, patch.title),
              h('p', { class: 'patch-description' }, patch.description),
              h('pre', { class: 'code' }, h('code', {}, patch.snippet)),
            ),
            apply,
          );
        }),
      ),
      this.patchObservation === null
        ? null
        : h(
            'p',
            { class: 'feedback feedback-danger', role: 'alert' },
            `✖ Reverted. ${this.patchObservation.text}`,
          ),
    );
  }

  /** Try a patch; the game closes the console when it works. */
  apply(patchId) {
    const check = this.host.applyPatch(this.bug, patchId);
    this.patchObservation = check.ok ? null : { patchId, text: check.observation };
    this.render();
    if (!check.ok) {
      this.element.querySelector(`[data-key="apply-${patchId}"]`)?.focus();
    }
  }
}

/** What to inspect inside the Sentry dashboard for each failure in Live mode. */
const SENTRY_BRIEFINGS = {
  weapon: [
    'Click "Investigate in Sentry" above to open the captured issue in a new tab.',
    'Inspect the Stack Trace to see which function and file threw the error.',
    'Check the weapon_state context section in Sentry to compare the requested weapon ID against the registered weapon configurations.',
  ],
  shield: [
    'Click "Investigate in Sentry" above to open the captured issue in a new tab.',
    'Read the Breadcrumbs timeline in Sentry leading up to hull destruction.',
    'Check the shield_state context section in Sentry to compare incoming projectile damage against the damage applied to your hull.',
  ],
  boss: [
    'Click "Investigate trace in Sentry" above to open the performance trace in a new tab.',
    'Inspect the Waterfall view under the boss-spawn root span.',
    'Notice that all four game.resource.load child spans run one after another (sequentially) totaling 4.50 s, and identify which operation takes the longest.',
  ],
};

/** Render the Sentry investigation checklist shown in Live mode. */
function renderSentryBriefing(evidence) {
  return h(
    'div',
    { class: 'sentry-briefing', 'aria-label': 'How to investigate in Sentry' },
    h('h3', { class: 'sentry-briefing-title' }, 'What to look for in Sentry'),
    h(
      'ol',
      { class: 'sentry-briefing-list' },
      ...SENTRY_BRIEFINGS[evidence.bug].map((item, index) =>
        h(
          'li',
          { class: 'sentry-briefing-item' },
          h('span', { class: 'option-letter', 'aria-hidden': 'true' }, String(index + 1)),
          h('span', {}, item),
        ),
      ),
    ),
  );
}

/** Render context tags as scannable pill badges. */
function renderContextPills(section) {
  return h(
    'dl',
    { class: 'context-pills', 'aria-label': section.title },
    ...Object.entries(section.entries).map(([key, value]) =>
      h('div', { class: 'context-pill' }, h('dt', {}, `${key}:`), h('dd', {}, value)),
    ),
  );
}

/** Render the primary diagnostic section on screen. */
function renderSection(section) {
  switch (section.kind) {
    case 'exception':
      return h(
        'div',
        { class: 'panel exception' },
        h('p', { class: 'error-type' }, section.errorType),
        h('p', { class: 'error-message' }, section.message),
      );
    case 'stacktrace':
      return h(
        'ol',
        { class: 'panel frames', 'aria-label': 'Stack frames, innermost first' },
        ...section.frames.map((frame, index) => frameRow(frame, index === 0)),
      );
    case 'breadcrumbs':
      return h(
        'ol',
        { class: 'panel crumbs', 'aria-label': 'Breadcrumbs, oldest first' },
        ...section.entries.map(crumbRow),
      );
    case 'context':
      return renderContextPills(section);
    case 'waterfall':
      return waterfall(section.totalMs, section.spans);
  }
}

/** One stack frame, highlighting the innermost culprit frame. */
function frameRow(frame, isCulprit) {
  const location = frame.line > 0 ? `${frame.file}:${frame.line}` : frame.file;

  return h(
    'li',
    {
      class: 'frame',
      'data-in-app': String(frame.inApp),
      'data-culprit': isCulprit ? 'true' : undefined,
    },
    h('span', { class: 'frame-fn' }, frame.functionName),
    h('span', { class: 'frame-loc' }, isCulprit ? `${location} ← THROWN HERE` : location),
  );
}

/** One breadcrumb. */
function crumbRow(entry) {
  const data =
    entry.data === null
      ? null
      : h(
          'span',
          { class: 'crumb-data' },
          Object.entries(entry.data)
            .map(([key, value]) => `${key}=${value}`)
            .join('  '),
        );

  return h(
    'li',
    { class: 'crumb', 'data-level': entry.level },
    h('span', { class: 'crumb-time' }, entry.offsetLabel),
    h('span', { class: 'crumb-level', 'aria-label': entry.level }, LEVEL_GLYPHS[entry.level]),
    h('span', { class: 'crumb-category' }, entry.category),
    h('span', { class: 'crumb-message' }, entry.message),
    data,
  );
}

/** A trace waterfall: one bar per span on a shared time axis, with the spawn budget marked. */
function waterfall(totalMs, spans) {
  const axisMs = Math.max(totalMs, BOSS_SPAWN_BUDGET_MS);
  const percent = (milliseconds) => `${((milliseconds / axisMs) * 100).toFixed(2)}%`;
  const seconds = (milliseconds) => `${(milliseconds / 1_000).toFixed(1)} s`;

  return h(
    'div',
    {
      class: 'panel waterfall',
      role: 'table',
      'aria-label': `Trace boss-spawn, ${seconds(totalMs)} total`,
    },
    h(
      'p',
      { class: 'waterfall-axis' },
      h('span', {}, '0 s'),
      h('span', {}, `total ${seconds(totalMs)} · budget ${seconds(BOSS_SPAWN_BUDGET_MS)}`),
    ),
    ...spans.map((span) => {
      const isRepeat = span.name === 'loadAnimations';

      return h(
        'div',
        { class: 'span-row', role: 'row', 'data-culprit': isRepeat ? 'true' : undefined },
        h('span', { class: 'span-name', role: 'cell' }, span.name),
        h(
          'span',
          { class: 'span-track', role: 'cell' },
          h('span', {
            class: 'span-bar',
            style: `left:${percent(span.startMs)};width:${percent(span.durationMs)}`,
          }),
          h('span', {
            class: 'span-budget',
            style: `left:${percent(BOSS_SPAWN_BUDGET_MS)}`,
            'aria-hidden': 'true',
          }),
        ),
        h(
          'span',
          { class: 'span-time', role: 'cell' },
          `${seconds(span.durationMs)} @ ${seconds(span.startMs)}`,
        ),
      );
    }),
  );
}

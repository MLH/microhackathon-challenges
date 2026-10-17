import { createProgress } from '../../../shared/progress.mjs';

import { loadBossResources } from '../boss/boss-loader.mjs';
import { BUG_DEFINITIONS } from '../bugs/bug-definitions.mjs';
import { tryRepair } from '../bugs/code-state.mjs';
import { IncidentTracker } from '../bugs/incident-tracker.mjs';
import { LiveEvidenceProvider } from '../diagnostics/live-evidence.mjs';
import { SimulatedEvidenceProvider } from '../diagnostics/simulated-evidence.mjs';
import { GameEngine } from '../engine/game-engine.mjs';
import { createRandom } from '../engine/random.mjs';
import { CanvasRenderer } from '../render/canvas-renderer.mjs';
import { attachBreadcrumbs } from '../sentry/breadcrumbs.mjs';
import { publishState } from '../session/monitor-state.mjs';

import { BossLoadingView } from '../ui/boss-loading.mjs';
import { onClick, setText } from '../ui/dom.mjs';
import { Hud } from '../ui/hud.mjs';
import { IncidentConsole } from '../ui/incident-console.mjs';
import { InputController } from '../ui/input.mjs';
import { completionCard, introCard, OverlayHost, pauseCard } from '../ui/overlays.mjs';
import { GameLoop } from './game-loop.mjs';
import { canonicalEncounter, codeForProgress, firstOpenBug, waveForBug } from './resume.mjs';

/** How long the banner after a success or patch stays up. */
const BANNER_MS = 6_000;

/** The pause after the last repair, so the participant sees the result before the recap. */
const COMPLETION_DELAY_MS = 1_800;

/** The seed that makes enemy fire reproducible unless the page asks for another. */
export const DEFAULT_SEED = 20_260_514;

/** Find a required element by id. */
function requireElement(id) {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`the page has no #${id} element`);
  }

  return element;
}

/** The game page. */
export class GameApp {
  options;
  now;
  stage = requireElement('stage');
  banner = requireElement('banner');
  announcer = requireElement('announcer');
  hud = new Hud();
  overlays = new OverlayHost(requireElement('overlay-root'));
  bossView = new BossLoadingView(requireElement('boss-loading'));
  engine;
  simulated = new SimulatedEvidenceProvider();
  live = null;
  incidentConsole;
  input;
  loop;
  evidenceByBug = new Map();
  tracker;
  progress;
  code;
  lastShieldHit = null;
  bannerTimer = null;
  pauseOpen = false;
  pendingStart = null;

  /**
   * @param {object} options the page's config, store, and hooks; `reporter` is given only in live
   *   mode and sends the failures to Sentry.
   * @param {object | null} saved the run to resume, if any.
   */
  constructor(options, saved) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
    const mode = options.reporter === undefined ? 'demo' : 'live';
    this.progress = saved ?? createProgress(options.config.attemptId, mode);
    this.tracker = new IncidentTracker(this.progress);
    this.code = codeForProgress(this.progress);

    this.engine = new GameEngine({
      random: createRandom(options.seed ?? DEFAULT_SEED),
      code: this.code,
      spawnBossResources: (strategy, onTask) => this.spawnBoss(strategy, onTask),
      now: this.now,
      particleScale: options.reducedMotion ? 0.25 : 1,
    });
    if (options.reporter !== undefined) {
      attachBreadcrumbs(this.engine, options.reporter);
      this.live = new LiveEvidenceProvider({
        reporter: options.reporter,
        simulated: this.simulated,
        fetchImpl: (input, init) => fetch(input, init),
      });
    }
    this.incidentConsole = new IncidentConsole({
      progressOf: (bug) => this.progress.bugs[bug],
      markEvidenceViewed: (bug) => this.tracker.markEvidenceViewed(bug),
      useHint: (bug) => this.tracker.useHint(bug),
      diagnose: (bug, optionId) => this.tracker.answerDiagnosis(bug, optionId),
      applyPatch: (bug, patchId) => this.applyPatch(bug, patchId),
    });

    const canvas = requireElement('arena');
    const renderer = new CanvasRenderer(canvas, { reducedMotion: options.reducedMotion });
    this.input = new InputController({
      onPauseKey: () => this.togglePause(),
      isGameActive: () => !this.overlays.isOpen && this.engine.world.phase !== 'ready',
    });
    this.loop = new GameLoop((elapsedMs, nowMs) => {
      this.engine.update(elapsedMs, this.input.current());
      renderer.draw(this.engine.world, nowMs);
      this.bossView.update(this.engine.world, this.now());
      this.hud.update(this.progress, this.engine.world);
    });
  }

  /** Wire the page, show the briefing or the saved run, and start drawing. */
  begin() {
    this.tracker.subscribe((progress) => this.onProgress(progress));
    this.engine.on((event) => this.onEvent(event));
    if (this.live !== null) {
      this.hud.showLiveMode();
    }
    publishState(document, this.progress);

    this.input.attach(document, {
      left: requireElement('pad-left'),
      right: requireElement('pad-right'),
      fire: requireElement('pad-fire'),
    });
    document.addEventListener('keydown', (event) => this.onPauseCardKey(event));
    onClick(requireElement('skip-ahead'), () => {
      this.engine.fastForward();
      this.stage.focus();
    });
    for (const id of ['reset-run', 'reset-controls']) {
      const button = document.getElementById(id);
      if (button !== null) {
        onClick(button, () => this.resetRun());
      }
    }
    this.showOpening();
    this.loop.start();
  }

  /** Load the boss's resources under the strategy the current code uses. */
  spawnBoss(strategy, onTask) {
    return loadBossResources({
      strategy,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      now: this.now,
      ...(onTask === undefined ? {} : { onTask }),
    });
  }

  /** Show the briefing for a new run, or the welcome-back card for a saved one. */
  showOpening() {
    if (!this.progress.launched) {
      this.overlays.show(
        introCard({ returning: false, onStart: () => this.startRun() }),
      );

      return;
    }

    if (this.progress.completed) {
      this.engine.start(1);
      this.engine.finish();
      this.overlays.show(
        completionCard(
          this.progress,
          () => this.continuePlaying(),
          () => this.resetRun(),
        ),
      );

      return;
    }

    const bug = firstOpenBug(this.progress);
    if (bug === null) {
      return;
    }
    const stage = this.progress.bugs[bug].stage;
    this.pendingStart = () => {
      if (stage === 'unseen') {
        this.engine.start(waveForBug(bug));

        return;
      }
      this.engine.restoreIncident(bug);
      this.openRestoredIncident(bug);
    };
    this.overlays.show(
      introCard({ returning: true, onStart: () => this.resumeRun() }),
    );
  }

  /** The participant pressed Start. */
  startRun() {
    this.tracker.launch();
    this.closeCard();
    this.engine.start(1);
    this.announce('Run started. Move with the arrow keys, fire with Space.');
  }

  /** The participant pressed Resume on the welcome-back card. */
  resumeRun() {
    this.closeCard();
    this.pendingStart?.();
    this.pendingStart = null;
    this.announce('Welcome back. Your run was restored.');
  }

  /** Close the card on screen and put focus back on the arena. */
  closeCard() {
    this.pauseOpen = false;
    this.overlays.hide(this.stage);
  }

  /** Pause or resume from the keyboard. */
  togglePause() {
    if (this.overlays.isOpen || this.engine.world.phase !== 'playing') {
      return;
    }
    this.engine.pause();
    this.input.releaseAll();
    this.pauseOpen = true;
    this.overlays.show(pauseCard(() => this.resumeFromPause()));
  }

  /** Close the pause card and continue. */
  resumeFromPause() {
    this.engine.resume();
    this.closeCard();
  }

  /** Let P or Escape close the pause card. */
  onPauseCardKey(event) {
    if (
      !event.defaultPrevented &&
      this.pauseOpen &&
      (event.code === 'KeyP' || event.code === 'Escape')
    ) {
      event.preventDefault();
      this.resumeFromPause();
    }
  }

  /** React to what the engine reports. */
  onEvent(event) {
    switch (event.type) {
      case 'weapon-jammed':
        this.openIncident({
          bug: 'weapon',
          jam: {
            weaponId: event.error.weaponId,
            availableWeapons: event.availableWeapons,
            error: event.error,
          },
        });
        break;
      case 'shield-hit':
        this.lastShieldHit = event;
        break;
      case 'ship-down':
        if (event.cause === 'shield-failure' && this.lastShieldHit !== null) {
          this.openIncident({
            bug: 'shield',
            failure: {
              incomingDamage: this.lastShieldHit.incomingDamage,
              actualDamage: this.lastShieldHit.outcome.actualDamage,
              hullBefore: this.lastShieldHit.hullBefore,
              hullAfter: this.lastShieldHit.hullAfter,
            },
          });
        }
        break;
      case 'boss-online':
        if (event.stalled) {
          this.openIncident({
            bug: 'boss',
            stall: {
              totalMs: event.result.totalMs,
              spans: event.result.spans.map((span) => ({
                name: span.name,
                operation: span.op,
                startMs: span.startMs,
                durationMs: span.durationMs,
              })),
            },
          });
        }
        break;
      case 'verification-passed':
        this.onVerified(event.bug);
        break;
      case 'pickup-collected':
        this.announce(event.kind === 'fanout' ? 'Fan-out upgrade equipped.' : 'Shield equipped.');
        break;
      case 'wave-started':
      case 'enemy-destroyed':
      case 'pickup-spawned':
      case 'volley-fired':
      case 'ship-restored':
      case 'boss-loading':
        break;
      case 'run-finished':
        if (this.freeplayActive) {
          this.freeplayActive = false;
          const bossDefeated = this.engine.world.boss === null;
          this.showBanner(
            bossDefeated
              ? '★ Monolith destroyed! All threats eliminated.'
              : 'Hull breached by The Monolith. Final score recorded.',
            bossDefeated ? 'success' : 'info',
          );
          setTimeout(() => this.complete(), 1_400);
        }
        break;
    }
  }

  /** A failure just happened in play: record it and open the console on its evidence. */
  openIncident(encounter) {
    const bug = encounter.bug;
    this.tracker.encounter(bug);
    this.input.releaseAll();
    this.incidentConsole.open(bug);
    this.overlays.show(this.incidentConsole.element);
    const definition = BUG_DEFINITIONS[bug];
    this.announce(
      `${definition.incidentLabel}: ${definition.title}. The Incident Console is open.`,
    );

    void (this.live ?? this.simulated)
      .evidenceFor(encounter)
      .then((evidence) => this.deliverEvidence(evidence));
  }

  /**
   * A failure was restored from a saved run: reopen the console on its evidence. The live capture is
   * gone and a second report would be a duplicate, so live mode falls back to simulated evidence.
   */
  openRestoredIncident(bug) {
    this.input.releaseAll();
    this.incidentConsole.open(bug);
    this.overlays.show(this.incidentConsole.element);
    const cached = this.evidenceByBug.get(bug);
    if (cached !== undefined) {
      this.incidentConsole.showEvidence(cached);

      return;
    }
    const encounter = canonicalEncounter(bug);
    const restored =
      this.live === null
        ? this.simulated.evidenceFor(encounter)
        : this.live.fallback(encounter, 'restored');
    void restored.then((evidence) => this.deliverEvidence(evidence));
  }

  /** Remember the evidence and show it if its console is still open. */
  deliverEvidence(evidence) {
    this.evidenceByBug.set(evidence.bug, evidence);
    this.incidentConsole.showEvidence(evidence);
  }

  /** Try a patch from the console. A good one is kept, closes the console, and starts the replay. */
  applyPatch(bug, patchId) {
    const trial = tryRepair(bug, patchId, this.code);
    this.tracker.recordRepairAttempt(bug, trial.check.ok);
    if (!trial.check.ok) {
      this.announce(`Patch reverted. ${trial.check.observation}`);

      return trial.check;
    }

    this.code = trial.state;
    this.engine.setCode(this.code);
    this.closeCard();
    this.engine.beginVerification(bug);
    this.showBanner(`Patch applied. ${BUG_DEFINITIONS[bug].verifyPrompt}`, 'info');
    this.announce(`Patch applied. ${BUG_DEFINITIONS[bug].verifyPrompt}`);

    return trial.check;
  }

  /** The repaired behavior was seen in the arena. */
  onVerified(bug) {
    this.tracker.markRepaired(bug);
    const definition = BUG_DEFINITIONS[bug];
    this.showBanner(`✓ ${definition.incidentLabel} fixed. ${definition.fixExplanation}`, 'success');
    this.announce(`${definition.title} repaired.`);

    if (this.tracker.allRepaired()) {
      setTimeout(() => this.complete(), COMPLETION_DELAY_MS);
    }
  }

  /** All three incidents are closed: freeze the arena and show the recap. */
  complete() {
    this.freeplayActive = false;
    this.engine.finish();
    this.input.releaseAll();
    this.hideBanner();
    this.overlays.show(
      completionCard(
        this.progress,
        () => this.continuePlaying(),
        () => this.resetRun(),
      ),
    );
    this.announce('All incidents closed.');
  }

  freeplayActive = false;

  /** Dismiss the completion recap and keep playing in the arena. */
  continuePlaying() {
    this.freeplayActive = true;
    this.closeCard();
    this.engine.continuePlaying();
    this.showBanner('Boss Showdown: Destroy The Monolith before your hull fails!', 'info');
    this.announce('Continuing play in the arena.');
  }

  /** Clear saved progress and reload the page for a fresh run. */
  resetRun() {
    void this.options.store.clear().then(() => this.options.reload());
  }

  /** Save and publish every progress change. */
  onProgress(progress) {
    this.progress = progress;
    void this.options.store.save(progress);
    publishState(document, progress);
  }

  /** Show a banner over the arena, replacing any earlier one. */
  showBanner(text, kind) {
    this.banner.dataset.kind = kind;
    setText(this.banner, text);
    this.banner.hidden = false;
    if (this.bannerTimer !== null) {
      clearTimeout(this.bannerTimer);
    }
    this.bannerTimer = setTimeout(() => this.hideBanner(), BANNER_MS);
  }

  /** Hide the banner. */
  hideBanner() {
    this.banner.hidden = true;
    if (this.bannerTimer !== null) {
      clearTimeout(this.bannerTimer);
      this.bannerTimer = null;
    }
  }

  /** Say something to screen readers. */
  announce(message) {
    setText(this.announcer, message);
  }
}

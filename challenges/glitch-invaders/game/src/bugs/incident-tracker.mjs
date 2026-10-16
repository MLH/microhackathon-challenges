/**
 * Progress through the three failures. Each failure moves `unseen → encountered → investigated →
 * repaired`, one step at a time, and every move is recorded as a milestone the guide can forward.
 */
import { BUG_IDS } from '../../../shared/progress.mjs';
import {
  SCORE_BUG_FOUND,
  SCORE_DIAGNOSIS_BASE,
  SCORE_DIAGNOSIS_FLOOR,
  SCORE_HINT_COST,
  SCORE_REPAIR_FIRST_TRY,
  SCORE_REPAIR_RETRY,
  SCORE_VERIFIED,
} from '../engine/constants.mjs';
import { BUG_DEFINITIONS } from './bug-definitions.mjs';

/** Thrown when an action does not fit the failure's current stage, such as diagnosing before seeing it. */
export class IllegalBugTransitionError extends Error {
  constructor(bug, action, stage) {
    super(`cannot ${action} for ${bug} while it is ${stage}`);
    this.name = 'IllegalBugTransitionError';
  }
}

/** The state machine behind the three failures. */
export class IncidentTracker {
  progress;
  listeners = new Set();

  constructor(initial) {
    this.progress = structuredClone(initial);
  }

  /** A copy of the current progress. */
  snapshot() {
    return structuredClone(this.progress);
  }

  /** Listen for changes; returns the function that stops listening. */
  subscribe(listener) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The stage of `bug`. */
  stageOf(bug) {
    return this.progress.bugs[bug].stage;
  }

  /** Whether every failure is repaired. */
  allRepaired() {
    return BUG_IDS.every((bug) => this.progress.bugs[bug].stage === 'repaired');
  }

  /** The participant pressed Start. Safe to call again. */
  launch() {
    if (this.progress.launched) {
      return;
    }

    this.progress.launched = true;
    this.record('run-started');
  }

  /** The failure became observable in play. Safe to call again. */
  encounter(bug) {
    const entry = this.progress.bugs[bug];
    if (entry.stage !== 'unseen') {
      return;
    }

    entry.stage = 'encountered';
    this.progress.score += SCORE_BUG_FOUND;
    this.record('bug-encountered', bug);
  }

  /** The participant opened the console's evidence for `bug`. */
  markEvidenceViewed(bug) {
    const entry = this.progress.bugs[bug];
    if (entry.stage === 'unseen') {
      throw new IllegalBugTransitionError(bug, 'view evidence', entry.stage);
    }
    if (entry.evidenceViewed) {
      return;
    }

    entry.evidenceViewed = true;
    this.record('evidence-viewed', bug);
  }

  /**
   * Reveal the next hint and charge for it.
   *
   * @returns the index of the newly revealed hint, or `null` when all three are already shown.
   */
  useHint(bug) {
    const entry = this.progress.bugs[bug];
    if (entry.hintsUsed >= BUG_DEFINITIONS[bug].hints.length) {
      return null;
    }

    entry.hintsUsed += 1;
    this.notify(null);

    return entry.hintsUsed - 1;
  }

  /**
   * Check a diagnosis. A right answer, given after viewing the evidence, makes the failure
   * `investigated`.
   *
   * @throws {IllegalBugTransitionError} when the evidence has not been viewed yet.
   */
  answerDiagnosis(bug, optionId) {
    const entry = this.progress.bugs[bug];
    if (entry.stage !== 'encountered' || !entry.evidenceViewed) {
      throw new IllegalBugTransitionError(bug, 'diagnose', entry.stage);
    }

    const option = BUG_DEFINITIONS[bug].options.find((candidate) => candidate.id === optionId);
    if (option === undefined) {
      throw new Error(`unknown diagnosis option for ${bug}: ${optionId}`);
    }

    entry.diagnosisAttempts += 1;
    if (!option.correct) {
      this.notify(null);

      return { correct: false, feedback: option.feedback };
    }

    entry.stage = 'investigated';
    this.progress.score += Math.max(
      SCORE_DIAGNOSIS_FLOOR,
      SCORE_DIAGNOSIS_BASE - SCORE_HINT_COST * entry.hintsUsed,
    );
    this.notify(null);

    return { correct: true, feedback: '' };
  }

  /**
   * Record that the participant applied a patch.
   *
   * @throws {IllegalBugTransitionError} when the failure has not been diagnosed.
   */
  recordRepairAttempt(bug, correct) {
    const entry = this.progress.bugs[bug];
    if (entry.stage !== 'investigated') {
      throw new IllegalBugTransitionError(bug, 'attempt a repair', entry.stage);
    }

    entry.repairAttempts += 1;
    if (correct) {
      this.progress.score +=
        entry.repairAttempts === 1 ? SCORE_REPAIR_FIRST_TRY : SCORE_REPAIR_RETRY;
    }
    this.record('repair-attempted', bug, correct);
  }

  /**
   * The repaired behavior was seen working in the game. Completes the run once all three are done.
   *
   * @throws {IllegalBugTransitionError} when the failure has not been diagnosed.
   */
  markRepaired(bug) {
    const entry = this.progress.bugs[bug];
    if (entry.stage === 'repaired') {
      return;
    }
    if (entry.stage !== 'investigated') {
      throw new IllegalBugTransitionError(bug, 'mark repaired', entry.stage);
    }

    entry.stage = 'repaired';
    this.progress.score += SCORE_VERIFIED;
    this.record('repair-succeeded', bug);

    if (this.allRepaired() && !this.progress.completed) {
      this.progress.completed = true;
      this.record('challenge-completed');
    }
  }

  /** Append a milestone and tell listeners. */
  record(name, bug, correct) {
    const seq = this.progress.milestones.length + 1;
    this.progress.milestones.push({
      seq,
      name,
      ...(bug === undefined ? {} : { bug }),
      ...(correct === undefined ? {} : { correct }),
    });
    this.notify(name);
  }

  /** Tell every listener about the current progress. */
  notify(change) {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      listener(snapshot, change);
    }
  }
}

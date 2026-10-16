/**
 * The "still there?" behavior: after a quiet stretch the game warns, counts down, and resets to the
 * intro so the next person never inherits a half-played run. Time is injected so tests need no
 * clock.
 */

/** Watches for quiet. Call {@link InactivityMonitor.noteActivity} on input and {@link InactivityMonitor.tick} regularly. */
export class InactivityMonitor {
  options;
  lastActivityAt;
  warnedAt = null;

  constructor(options) {
    this.options = options;
    this.lastActivityAt = options.now();
  }

  /** Whether the warning is showing. */
  get state() {
    return this.warnedAt === null ? 'active' : 'warning';
  }

  /** Whole seconds left before reset while warning; `0` when active. */
  secondsLeft() {
    if (this.warnedAt === null) {
      return 0;
    }
    const remaining = this.warnedAt + this.options.resetAfterWarningMs - this.options.now();

    return Math.max(0, Math.ceil(remaining / 1_000));
  }

  /** The participant did something. Dismisses a warning. */
  noteActivity() {
    this.lastActivityAt = this.options.now();
    if (this.warnedAt !== null) {
      this.warnedAt = null;
      this.options.onResume();
    }
  }

  /** Check the clock: raise the warning after quiet, and reset once the countdown ends. */
  tick() {
    const now = this.options.now();
    if (this.warnedAt === null) {
      if (now - this.lastActivityAt >= this.options.warningAfterMs) {
        this.warnedAt = now;
        this.options.onWarning();
      }

      return;
    }

    if (now - this.warnedAt >= this.options.resetAfterWarningMs) {
      this.warnedAt = null;
      this.lastActivityAt = now;
      this.options.onReset();
    }
  }
}

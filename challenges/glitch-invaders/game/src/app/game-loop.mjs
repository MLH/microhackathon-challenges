/** The animation frame loop: one `step` per frame, with the elapsed time since the last one. */

/** Runs a {@link FrameStep} on every animation frame until stopped. */
export class GameLoop {
  step;
  handle = null;
  previousMs = 0;

  constructor(step) {
    this.step = step;
  }

  /** Begin looping. Starting twice does nothing. */
  start() {
    if (this.handle !== null) {
      return;
    }

    this.previousMs = performance.now();
    this.handle = requestAnimationFrame((nowMs) => this.frame(nowMs));
  }

  /** Stop looping. */
  stop() {
    if (this.handle !== null) {
      cancelAnimationFrame(this.handle);
      this.handle = null;
    }
  }

  /** Run one frame and ask for the next. */
  frame(nowMs) {
    const elapsedMs = Math.max(0, nowMs - this.previousMs);
    this.previousMs = nowMs;
    this.step(elapsedMs, nowMs);
    this.handle = requestAnimationFrame((next) => this.frame(next));
  }
}

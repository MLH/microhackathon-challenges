/**
 * Player input: keyboard and on-screen controls feed one shared {@link InputState}. Holding a pad
 * button works with a pointer, and a tap on a move pad carries the ship one lane; pressing it with
 * Enter or Space gives a short pulse, so a keyboard user can drive the pads too.
 */
import { ENEMY_GAP_X, ENEMY_WIDTH, PLAYER_SPEED } from '../engine/constants.mjs';
import { idleInput } from '../engine/world.mjs';

/** How long a keyboard activation of a pad button counts as held. */
const PAD_PULSE_MS = 180;

/** A tap on a move pad holds long enough to carry the ship one enemy-formation lane. */
export const TAP_MOVE_MS = Math.round(((ENEMY_WIDTH + ENEMY_GAP_X) / PLAYER_SPEED) * 1000);

/** The keys that mean each control. */
const KEY_CONTROLS = new Map([
  ['ArrowLeft', 'left'],
  ['KeyA', 'left'],
  ['ArrowRight', 'right'],
  ['KeyD', 'right'],
  ['Space', 'fire'],
]);

/** The move pad that cancels each move pad's pending tap when pressed. */
const OPPOSITE_PADS = new Map([
  ['left', 'right'],
  ['right', 'left'],
]);

/** Collects keyboard and pad input. */
export class InputController {
  state = idleInput();
  keysDown = new Set();
  /** The pointer IDs holding each pad down, so a stray release from another pointer is ignored. */
  pointersDown = new Map();
  /** Each control's timed hold from a tap or a keyboard pulse, as `{ timer, endsAt }`. */
  timedHolds = new Map();
  options;

  constructor(options) {
    this.options = options;
  }

  /** The current input. The same object every time; the engine only reads it. */
  current() {
    return this.state;
  }

  /** Start listening on `target` for keys, and on `pad` buttons for pointers. */
  attach(target, pads) {
    const keyDown = (event) => this.keyDown(event);
    const keyUp = (event) => this.keyUp(event);
    const blur = () => this.releaseAll();
    target.addEventListener('keydown', keyDown);
    target.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);

    for (const control of Object.keys(pads)) {
      this.attachPad(control, pads[control]);
    }

    return () => {
      target.removeEventListener('keydown', keyDown);
      target.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
      this.releaseAll();
    };
  }

  /** Let go of everything, such as when a dialog opens or the window loses focus. */
  releaseAll() {
    this.keysDown.clear();
    this.pointersDown.clear();
    for (const control of [...this.timedHolds.keys()]) {
      this.cancelTimedHold(control);
    }
    this.recompute();
  }

  /**
   * Wire one pad button: hold with a pointer, pulse with the keyboard. A pointer's hold ends on its
   * first release event; browsers send `pointerleave` right after `pointerup` on touch, and that
   * second release must not end a tap's timed hold.
   */
  attachPad(control, button) {
    const press = (event) => {
      event.preventDefault();
      const pointers = this.pointersDown.get(control) ?? new Set();
      pointers.add(event.pointerId);
      this.pointersDown.set(control, pointers);
      if (OPPOSITE_PADS.has(control)) {
        this.cancelTimedHold(OPPOSITE_PADS.get(control));
        this.tap(control);
      }
      this.recompute();
    };
    const release = (event) => {
      if (this.pointersDown.get(control)?.delete(event.pointerId)) {
        this.recompute();
      }
    };

    button.addEventListener('pointerdown', press);
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('pointerleave', release);
    button.addEventListener('click', (event) => {
      if (event.detail !== 0) {
        return;
      }
      this.pulse(control);
    });
  }

  /** A tap on a move pad: hold one more lane's worth, so two quick taps move about two lanes. */
  tap(control) {
    const now = Date.now();
    const pendingEnd = this.timedHolds.get(control)?.endsAt ?? now;
    this.holdUntil(control, Math.max(pendingEnd, now) + TAP_MOVE_MS);
  }

  /** Hold `control` for a keyboard activation; repeats do not add up, so auto-repeat stops on release. */
  pulse(control) {
    const pendingEnd = this.timedHolds.get(control)?.endsAt ?? 0;
    this.holdUntil(control, Math.max(pendingEnd, Date.now() + PAD_PULSE_MS));
    this.recompute();
  }

  /** Hold `control` until the `endsAt` timestamp, replacing any timed hold it has. */
  holdUntil(control, endsAt) {
    this.cancelTimedHold(control);
    const timer = setTimeout(() => {
      this.timedHolds.delete(control);
      this.recompute();
    }, endsAt - Date.now());
    this.timedHolds.set(control, { timer, endsAt });
  }

  /** End `control`'s timed hold early, if it has one. The caller recomputes. */
  cancelTimedHold(control) {
    const hold = this.timedHolds.get(control);
    if (hold === undefined) {
      return;
    }

    clearTimeout(hold.timer);
    this.timedHolds.delete(control);
  }

  /** Handle a key press. */
  keyDown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    if (event.code === 'KeyP' || event.code === 'Escape') {
      if (!event.repeat && this.options.isGameActive()) {
        event.preventDefault();
        this.options.onPauseKey();
      }

      return;
    }
    if (!this.options.isGameActive() || !KEY_CONTROLS.has(event.code)) {
      return;
    }
    if (event.code === 'Space' && isButton(event.target)) {
      return;
    }

    event.preventDefault();
    this.keysDown.add(event.code);
    this.recompute();
  }

  /** Handle a key release. */
  keyUp(event) {
    if (this.keysDown.delete(event.code)) {
      this.recompute();
    }
  }

  /** Rebuild the shared state from what is held. */
  recompute() {
    const held = (control) =>
      (this.pointersDown.get(control)?.size ?? 0) > 0 ||
      this.timedHolds.has(control) ||
      [...this.keysDown].some((code) => KEY_CONTROLS.get(code) === control);

    this.state.left = held('left');
    this.state.right = held('right');
    this.state.fire = held('fire');
  }
}

/** Whether `target` is a button, which handles Space itself. */
function isButton(target) {
  return target instanceof HTMLButtonElement;
}

/**
 * Player input: keyboard and on-screen controls feed one shared {@link InputState}. Holding a pad
 * button works with a pointer; pressing it with Enter or Space gives a short pulse, so a keyboard
 * user can drive the pads too.
 */
import { idleInput } from '../engine/world.mjs';

/** How long a keyboard activation of a pad button counts as held. */
const PAD_PULSE_MS = 180;

/** The keys that mean each control. */
const KEY_CONTROLS = new Map([
  ['ArrowLeft', 'left'],
  ['KeyA', 'left'],
  ['ArrowRight', 'right'],
  ['KeyD', 'right'],
  ['Space', 'fire'],
]);

/** Collects keyboard and pad input. */
export class InputController {
  state = idleInput();
  keysDown = new Set();
  padsDown = new Map();
  options;
  pulseTimers = new Set();

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
    const pointer = () => this.options.onActivity();
    target.addEventListener('keydown', keyDown);
    target.addEventListener('keyup', keyUp);
    target.addEventListener('pointerdown', pointer);
    window.addEventListener('blur', blur);

    for (const control of Object.keys(pads)) {
      this.attachPad(control, pads[control]);
    }

    return () => {
      target.removeEventListener('keydown', keyDown);
      target.removeEventListener('keyup', keyUp);
      target.removeEventListener('pointerdown', pointer);
      window.removeEventListener('blur', blur);
      this.releaseAll();
    };
  }

  /** Let go of everything, such as when a dialog opens or the window loses focus. */
  releaseAll() {
    this.keysDown.clear();
    this.padsDown.clear();
    for (const timer of this.pulseTimers) {
      clearTimeout(timer);
    }
    this.pulseTimers.clear();
    this.recompute();
  }

  /** Wire one pad button: hold with a pointer, pulse with the keyboard. */
  attachPad(control, button) {
    const press = (event) => {
      event.preventDefault();
      this.options.onActivity();
      this.padsDown.set(control, (this.padsDown.get(control) ?? 0) + 1);
      this.recompute();
    };
    const release = () => {
      const holds = this.padsDown.get(control) ?? 0;
      if (holds > 0) {
        this.padsDown.set(control, holds - 1);
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
      this.options.onActivity();
      this.pulse(control);
    });
  }

  /** Hold `control` briefly. */
  pulse(control) {
    this.padsDown.set(control, (this.padsDown.get(control) ?? 0) + 1);
    this.recompute();
    const timer = setTimeout(() => {
      this.pulseTimers.delete(timer);
      const holds = this.padsDown.get(control) ?? 0;
      this.padsDown.set(control, Math.max(0, holds - 1));
      this.recompute();
    }, PAD_PULSE_MS);
    this.pulseTimers.add(timer);
  }

  /** Handle a key press. */
  keyDown(event) {
    this.options.onActivity();
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
      (this.padsDown.get(control) ?? 0) > 0 ||
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

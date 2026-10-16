/**
 * The state surface for Boothstrap's browser monitor. The monitor can only read the page's
 * accessibility tree, so the state is a fixed-word line of visually hidden text; the full snapshot
 * is also on `window` for tests and for a guide that can evaluate scripts.
 */
import { monitorStateLine } from '../../../shared/progress.mjs';

/** The id of the element holding the state line. */
export const STATE_ELEMENT_ID = 'boothstrap-state';

/** The `window` property holding the latest progress snapshot. */
export const STATE_WINDOW_KEY = '__GLITCH_STATE__';

/** Write `progress` to the marker element and `window`. */
export function publishState(document, progress) {
  const element = document.getElementById(STATE_ELEMENT_ID);
  if (element === null) {
    throw new Error(`the page has no #${STATE_ELEMENT_ID} element`);
  }

  const line = monitorStateLine(progress);
  if (element.textContent !== line) {
    element.textContent = line;
  }
  Object.defineProperty(document.defaultView ?? globalThis, STATE_WINDOW_KEY, {
    value: structuredClone(progress),
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

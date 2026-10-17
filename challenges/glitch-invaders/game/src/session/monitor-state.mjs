/**
 * The state surface for Boothstrap's browser monitor. The monitor can only read the page's
 * accessibility tree, so the state is a fixed-word line of text on the page.
 */
import { monitorStateLine } from '../../../shared/progress.mjs';

/** The id of the element holding the state line. */
export const STATE_ELEMENT_ID = 'boothstrap-state';

/** Write `progress` to the marker element. */
export function publishState(document, progress) {
  const element = document.getElementById(STATE_ELEMENT_ID);
  if (element === null) {
    throw new Error(`the page has no #${STATE_ELEMENT_ID} element`);
  }

  const line = monitorStateLine(progress);
  if (element.textContent !== line) {
    element.textContent = line;
  }
}

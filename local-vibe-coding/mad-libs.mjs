import * as kit from '@earendil-works/pi-tui';
import registerPromptFlow from './prompt-flow.mjs';

export default function madLibs(pi) {
  registerPromptFlow(pi, kit);
}

/** Shield damage rules, with the amplification bug that is the second intentional failure. */
import { SHIELD_BUG_MULTIPLIER } from '../engine/constants.mjs';

/**
 * Apply an enemy hit of `incomingDamage`.
 *
 * INTENTIONAL BUG: while `behavior` is `amplify`, an active shield multiplies the damage instead of
 * absorbing it.
 */
export function resolveShieldHit(behavior, shieldActive, incomingDamage) {
  if (!shieldActive) {
    return { actualDamage: incomingDamage, shieldConsumed: false };
  }

  switch (behavior) {
    case 'amplify':
      return { actualDamage: incomingDamage * SHIELD_BUG_MULTIPLIER, shieldConsumed: true };
    case 'absorb':
      return { actualDamage: 0, shieldConsumed: true };
    case 'pass-through':
      return { actualDamage: incomingDamage, shieldConsumed: false };
    case 'drop-then-pass':
      return { actualDamage: incomingDamage, shieldConsumed: true };
  }
}

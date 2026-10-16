/**
 * Rebuilding a saved run after a refresh: the code the repaired bugs left behind, and the evidence
 * for a failure that was still open. Evidence rebuilt this way is always the simulated fixture,
 * because the live capture is gone and a second Sentry report would be a duplicate.
 */
import { BUG_IDS } from '../../../shared/progress.mjs';
import { CORRECT_PATCH_IDS, createBrokenCodeState, tryRepair } from '../bugs/code-state.mjs';

import { SEQUENTIAL_BOSS_SPANS } from '../diagnostics/evidence-builders.mjs';
import { WeaponConfigError } from '../weapons/weapons.mjs';

/** The code with every already repaired bug fixed. */
export function codeForProgress(progress) {
  let code = createBrokenCodeState();
  for (const bug of BUG_IDS) {
    if (progress.bugs[bug].stage === 'repaired') {
      code = tryRepair(bug, CORRECT_PATCH_IDS[bug], code).state;
    }
  }

  return code;
}

/** The first failure that is not repaired, or `null` when all are. */
export function firstOpenBug(progress) {
  return BUG_IDS.find((bug) => progress.bugs[bug].stage !== 'repaired') ?? null;
}

/** The wave a run starts at to reach `bug`: the weapon in wave 1, the shield in 2, the boss in 3. */
export function waveForBug(bug) {
  return bug === 'weapon' ? 1 : bug === 'shield' ? 2 : 3;
}

/** What `bug` looked like when it happened, for evidence rebuilt after a refresh. */
export function canonicalEncounter(bug) {
  switch (bug) {
    case 'weapon':
      return {
        bug,
        jam: {
          weaponId: 'fanout',
          availableWeapons: ['single'],
          error: new WeaponConfigError('fanout'),
        },
      };
    case 'shield':
      return {
        bug,
        failure: { incomingDamage: 1, actualDamage: 3, hullBefore: 3, hullAfter: 0 },
      };
    case 'boss':
      return {
        bug,
        stall: { totalMs: 4_500, spans: [...SEQUENTIAL_BOSS_SPANS], traceId: null },
      };
  }
}

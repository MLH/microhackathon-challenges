/**
 * The mutable "code" of the game: the three things a patch can change. The shipped state is
 * deliberately broken, and the Incident Console's patches transform it.
 */

import { plannedLoadMs, tasksFor } from '../boss/boss-loader.mjs';
import { BOSS_SPAWN_BUDGET_MS } from '../engine/constants.mjs';
import { resolveShieldHit } from '../shield/shield.mjs';
import {
  createBrokenWeaponTable,
  FANOUT_VOLLEY,
  fireWeapon,
  SINGLE_SHOT,
  WeaponConfigError,
} from '../weapons/weapons.mjs';

/** The state as shipped, with all three intentional bugs present. */
export function createBrokenCodeState() {
  return {
    weapons: createBrokenWeaponTable(),
    shield: 'amplify',
    bossLoad: 'sequential',
  };
}

/** The shortest cooldown the weapon loop can tolerate without flooding. */
const MIN_SAFE_COOLDOWN_MS = 100;

/** Install `config` as the `fanout` weapon. */
function withFanout(state, config) {
  return { ...state, weapons: { ...state.weapons, fanout: config } };
}

/**
 * The patches for each failure, in the order the console lists them. Exactly one per failure is
 * correct and it is never first, so position gives nothing away; the rest fail their check.
 */
export const REPAIR_PATCHES = {
  weapon: [
    {
      id: 'add-fanout-zero-cooldown',
      title: 'Add fanout with no cooldown',
      description: 'Three projectiles and no delay between volleys. Maximum firepower.',
      snippet:
        'weapons.fanout = {\n  projectileCount: 3,\n  spreadDegrees: 24,\n  cooldownMs: 0,\n  damage: 1,\n};',
      apply: (state) => withFanout(state, { ...FANOUT_VOLLEY, cooldownMs: 0 }),
    },
    {
      id: 'add-fanout-config',
      title: 'Add the missing fanout config',
      description:
        'Register the complete fan-out volley: 3 projectiles, a 24° fan, 300 ms cooldown.',
      snippet:
        'weapons.fanout = {\n  projectileCount: 3,\n  spreadDegrees: 24,\n  cooldownMs: 300,\n  damage: 1,\n};',
      apply: (state) => withFanout(state, FANOUT_VOLLEY),
    },
    {
      id: 'add-single-projectile-fanout',
      title: 'Register fanout as a basic shot',
      description: 'Add a fanout entry that copies the single weapon. Simple, so safe?',
      snippet: 'weapons.fanout = { ...weapons.single };',
      apply: (state) => withFanout(state, SINGLE_SHOT),
    },
  ],
  shield: [
    {
      id: 'remove-multiplier',
      title: 'Remove the ×3 multiplier',
      description: 'Let damage pass through normally and keep the shield up.',
      snippet: 'if (shieldActive) {\n  actualDamage = incomingDamage;\n}',
      apply: (state) => ({ ...state, shield: 'pass-through' }),
    },
    {
      id: 'drop-shield-on-hit',
      title: 'Switch the shield off on impact',
      description: 'Turn the shield off when it is hit, but still apply the damage.',
      snippet: 'if (shieldActive) {\n  shieldActive = false;\n  actualDamage = incomingDamage;\n}',
      apply: (state) => ({ ...state, shield: 'drop-then-pass' }),
    },
    {
      id: 'shield-absorbs-hit',
      title: 'Absorb the hit completely',
      description: 'While the shield is active, apply 0 damage and consume the shield.',
      snippet: 'if (shieldActive) {\n  actualDamage = 0;\n  shieldConsumed = true;\n}',
      apply: (state) => ({ ...state, shield: 'absorb' }),
    },
  ],
  boss: [
    {
      id: 'parallelize-everything',
      title: 'Await all four loads in parallel',
      description:
        'Start every load at once with Promise.all, but still wait for the heavy 1.8 s loadAnimations() call before spawning.',
      snippet:
        'await Promise.all([\n  loadTextures(),\n  loadSounds(),\n  loadAnimations(), // still blocks for 1.8 s\n  initializeAI(),\n]);',
      apply: (state) => ({ ...state, bossLoad: 'parallel-all' }),
    },
    {
      id: 'parallel-without-redundant-load',
      title: 'Parallelize core loads, stream animations',
      description:
        'Run loadTextures, loadSounds, and initializeAI in parallel, and stream loadAnimations() without blocking spawn.',
      snippet:
        'await Promise.all([\n  loadTextures(),\n  loadSounds(),\n  initializeAI(),\n]);\nvoid loadAnimations(); // non-blocking',
      apply: (state) => ({ ...state, bossLoad: 'parallel-deduplicated' }),
    },
    {
      id: 'add-cache-checks',
      title: 'Check a cache before each load',
      description:
        'Skip a load if its result is cached. On first spawn, all four loads still run one after another.',
      snippet:
        "if (!cache.has('textures')) await loadTextures();\nif (!cache.has('sounds')) await loadSounds();\nif (!cache.has('anims')) await loadAnimations();\nif (!cache.has('ai')) await initializeAI();",
      apply: (state) => ({ ...state, bossLoad: 'cached-sequential' }),
    },
  ],
};

/** Format milliseconds as seconds with one decimal, such as `1.8 s`. */
function seconds(milliseconds) {
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

/** Try firing the upgrade and report whether the result is the intended three-way fan. */
function checkWeapon(state) {
  try {
    const { shots, config } = fireWeapon(state.weapons, 'fanout');
    if (shots.length !== 3) {
      return {
        ok: false,
        observation: `The upgrade fired ${shots.length} projectile${shots.length === 1 ? '' : 's'}. A fan-out should fire 3.`,
      };
    }
    if (config.cooldownMs < MIN_SAFE_COOLDOWN_MS) {
      return {
        ok: false,
        observation: `A ${config.cooldownMs} ms cooldown lets the weapon fire every frame and floods the game loop.`,
      };
    }

    return { ok: true, observation: 'The upgrade fired a 3-way fan with a 300 ms cooldown.' };
  } catch (error) {
    if (error instanceof WeaponConfigError) {
      return { ok: false, observation: error.message };
    }
    throw error;
  }
}

/** Hit an active shield and report whether it protected the ship. */
function checkShield(state) {
  const outcome = resolveShieldHit(state.shield, true, 1);
  if (outcome.actualDamage > 0) {
    return {
      ok: false,
      observation: outcome.shieldConsumed
        ? `The shield switched off, but the hit still landed for ${outcome.actualDamage}. A shield must absorb it.`
        : `The shield let ${outcome.actualDamage} damage through and stayed up. A shield must absorb the hit.`,
    };
  }

  return { ok: true, observation: 'The shield absorbed the hit: 0 damage, shield consumed.' };
}

/** Spawn the boss on a cold start and report whether it stays within the budget. */
function checkBoss(state) {
  const totalMs = plannedLoadMs(state.bossLoad);
  const blocksOnAnimations = tasksFor(state.bossLoad).some(
    (task) => task.name === 'loadAnimations',
  );
  if (totalMs > BOSS_SPAWN_BUDGET_MS) {
    return {
      ok: false,
      observation: `The boss still took ${seconds(totalMs)} to spawn on a cold start. The budget is ${seconds(BOSS_SPAWN_BUDGET_MS)}.`,
    };
  }
  if (blocksOnAnimations) {
    return {
      ok: false,
      observation: `The boss spawned in ${seconds(totalMs)}, which still blocks on the 1.8 s loadAnimations() call.`,
    };
  }

  return {
    ok: true,
    observation: `The boss spawned in ${seconds(totalMs)} by running core loads in parallel without blocking on loadAnimations.`,
  };
}

/** Run the behavior check for `bug` against `state`. */
export function checkRepair(bug, state) {
  switch (bug) {
    case 'weapon':
      return checkWeapon(state);
    case 'shield':
      return checkShield(state);
    case 'boss':
      return checkBoss(state);
  }
}

/**
 * Try patch `patchId` for `bug` on `state`. A patch that fails its check is reverted, so a wrong
 * choice never leaves the game in a half-fixed state.
 *
 * @throws {Error} when `patchId` is not a patch for `bug`.
 */
export function tryRepair(bug, patchId, state) {
  const patch = REPAIR_PATCHES[bug].find((candidate) => candidate.id === patchId);
  if (patch === undefined) {
    throw new Error(`unknown patch for ${bug}: ${patchId}`);
  }

  const patched = patch.apply(state);
  const check = checkRepair(bug, patched);

  return { patchId, state: check.ok ? patched : state, check };
}

/** The one patch per failure that passes its behavior check, for restoring a saved run. */
export const CORRECT_PATCH_IDS = {
  weapon: 'add-fanout-config',
  shield: 'shield-absorbs-hit',
  boss: 'parallel-without-redundant-load',
};

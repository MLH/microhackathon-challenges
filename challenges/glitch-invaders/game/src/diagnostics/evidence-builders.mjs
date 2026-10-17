import { BOSS_SPAWN_BUDGET_MS } from '../engine/constants.mjs';

/** Format milliseconds as seconds, such as `1.8 s`. */
function seconds(milliseconds) {
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

/**
 * Where the weapon failure's stack frames point. A unit test checks each line still holds the call
 * it names, so these cannot drift from the source unnoticed.
 */
export const WEAPON_STACK_FRAMES = [
  { functionName: 'fireWeapon', file: 'game/src/weapons/weapons.mjs', line: 46, inApp: true },
  {
    functionName: 'GameEngine.tryFire',
    file: 'game/src/engine/game-engine.mjs',
    line: 320,
    inApp: true,
  },
  {
    functionName: 'GameEngine.updatePlayer',
    file: 'game/src/engine/game-engine.mjs',
    line: 294,
    inApp: true,
  },
  {
    functionName: 'GameEngine.update',
    file: 'game/src/engine/game-engine.mjs',
    line: 160,
    inApp: true,
  },
  { functionName: 'GameLoop.frame', file: 'game/src/app/app.mjs', line: 94, inApp: true },
  { functionName: 'requestAnimationFrame', file: '<browser>', line: 0, inApp: false },
];

/** The canonical boss waterfall: the four loads, back to back. */
export const SEQUENTIAL_BOSS_SPANS = [
  { name: 'loadTextures', operation: 'game.resource.load', startMs: 0, durationMs: 1_200 },
  { name: 'loadSounds', operation: 'game.resource.load', startMs: 1_200, durationMs: 1_000 },
  { name: 'loadAnimations', operation: 'game.resource.load', startMs: 2_200, durationMs: 1_800 },
  { name: 'initializeAI', operation: 'game.resource.load', startMs: 4_000, durationMs: 500 },
];

/** The canonical run-up to the shield failure, used by the simulated provider's breadcrumbs. */
export const SIMULATED_SHIELD_BREADCRUMBS = [
  {
    offsetLabel: '-9.4 s',
    category: 'game.wave',
    message: 'Wave 2 started',
    level: 'info',
    data: null,
  },
  {
    offsetLabel: '-6.8 s',
    category: 'game.shield',
    message: 'Shield collected',
    level: 'info',
    data: { type: 'aegis' },
  },
  {
    offsetLabel: '-6.8 s',
    category: 'game.shield',
    message: 'Shield enabled',
    level: 'info',
    data: { shieldActive: 'true' },
  },
  {
    offsetLabel: '-1.2 s',
    category: 'game.combat',
    message: 'Incoming damage: 1',
    level: 'info',
    data: { damage: '1' },
  },
  {
    offsetLabel: '-1.2 s',
    category: 'game.shield',
    message: 'Shield active: true',
    level: 'info',
    data: { shieldActive: 'true' },
  },
  {
    offsetLabel: '-1.2 s',
    category: 'game.combat',
    message: 'Actual damage applied: 3',
    level: 'warning',
    data: { actualDamage: '3', expected: '0' },
  },
  {
    offsetLabel: '0.0 s',
    category: 'game.combat',
    message: 'Ship destroyed: shield failed to protect',
    level: 'error',
    data: null,
  },
];

/** The title Sentry would give the issue or trace for `encounter`. */
export function evidenceTitle(encounter) {
  switch (encounter.bug) {
    case 'weapon':
      return `WeaponConfigError: Configuration missing for weapon: ${encounter.jam.weaponId}`;
    case 'shield':
      return `GameLogicError: Shield was active but ${encounter.failure.actualDamage} damage was applied (expected 0)`;
    case 'boss':
      return `boss-spawn took ${seconds(encounter.stall.totalMs)} (budget ${seconds(BOSS_SPAWN_BUDGET_MS)})`;
  }
}

/**
 * The sections for `encounter`. `breadcrumbs` is the trail to show for the shield failure, and
 * `spans` is the waterfall to show for the boss stall.
 */
export function evidenceSections(encounter, breadcrumbs, spans) {
  switch (encounter.bug) {
    case 'weapon':
      return [
        {
          kind: 'exception',
          title: 'Exception',
          errorType: 'WeaponConfigError',
          message: `Configuration missing for weapon: ${encounter.jam.weaponId}`,
        },
        { kind: 'stacktrace', title: 'Stack trace', frames: [...WEAPON_STACK_FRAMES] },
        {
          kind: 'context',
          title: 'weapon_state',
          contextName: 'weapon_state',
          entries: {
            attemptedWeapon: encounter.jam.weaponId,
            availableWeapons: encounter.jam.availableWeapons.join(', '),
          },
        },
      ];
    case 'shield':
      return [
        {
          kind: 'exception',
          title: 'Exception',
          errorType: 'GameLogicError',
          message: `Shield was active but ${encounter.failure.actualDamage} damage was applied (expected 0). Ship destroyed despite an active shield.`,
        },
        { kind: 'breadcrumbs', title: 'Breadcrumbs', entries: [...breadcrumbs] },
        {
          kind: 'context',
          title: 'shield_state',
          contextName: 'shield_state',
          entries: {
            shieldActive: 'true',
            incomingDamage: String(encounter.failure.incomingDamage),
            actualDamage: String(encounter.failure.actualDamage),
            expectedDamage: '0',
            hullBefore: String(encounter.failure.hullBefore),
            hullAfter: String(encounter.failure.hullAfter),
          },
        },
      ];
    case 'boss':
      return [
        {
          kind: 'waterfall',
          title: 'Trace: boss-spawn',
          totalMs: spans.reduce((end, span) => Math.max(end, span.startMs + span.durationMs), 0),
          spans: [...spans],
        },
        {
          kind: 'context',
          title: 'boot_state',
          contextName: 'boot_state',
          entries: {
            animationsLoaded: 'at game start',
            spawnBudget: seconds(BOSS_SPAWN_BUDGET_MS),
            strategy: 'sequential',
          },
        },
      ];
  }
}

/** Format an issue reference for the simulated provider, such as `SIM-WEAPON-1`. */
export function simulatedReference(bug) {
  return `SIM-${bug.toUpperCase()}-1`;
}

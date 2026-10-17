/** Weapon configuration, with the missing entry that causes the first intentional failure. */

/** Thrown when the ship fires a weapon that has no configuration. */
export class WeaponConfigError extends Error {
  weaponId;

  constructor(weaponId) {
    super(`Configuration missing for weapon: ${weaponId}`);
    this.name = 'WeaponConfigError';
    this.weaponId = weaponId;
  }
}

/** The one weapon that is configured from the start. */
export const SINGLE_SHOT = {
  projectileCount: 1,
  spreadDegrees: 0,
  cooldownMs: 220,
  damage: 1,
};

/**
 * The table as shipped. INTENTIONAL BUG: there is no `fanout` entry, so the upgrade jams the
 * first time it fires. The Incident Console's patch adds it.
 */
export function createBrokenWeaponTable() {
  return { single: SINGLE_SHOT };
}

/** The configuration the correct patch registers: three projectiles in a fan with a sane cooldown. */
export const FANOUT_VOLLEY = {
  projectileCount: 3,
  spreadDegrees: 24,
  cooldownMs: 300,
  damage: 1,
};

/**
 * Fire `weaponId` from `table`.
 *
 * @throws {WeaponConfigError} when `table` has no entry for `weaponId`: the intentional bug.
 */
export function fireWeapon(table, weaponId) {
  const config = table[weaponId];
  if (config === undefined) {
    throw new WeaponConfigError(weaponId);
  }

  const spreadRadians = (config.spreadDegrees * Math.PI) / 180;
  const shots = [];
  for (let index = 0; index < config.projectileCount; index += 1) {
    const fraction = config.projectileCount === 1 ? 0.5 : index / (config.projectileCount - 1);
    shots.push({ angle: -spreadRadians / 2 + spreadRadians * fraction, damage: config.damage });
  }

  return { shots, config };
}

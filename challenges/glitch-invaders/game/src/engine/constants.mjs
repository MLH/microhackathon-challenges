/** Fixed numbers for the arena, ship, enemies, and incidents. Distances are world pixels. */

/** Width of the arena in world pixels; the canvas scales it to fit the screen. */
export const WORLD_WIDTH = 800;

/** Height of the arena in world pixels. */
export const WORLD_HEIGHT = 500;

/** Ship footprint. */
export const PLAYER_WIDTH = 40;
export const PLAYER_HEIGHT = 26;

/** Vertical position of the ship's top edge. */
export const PLAYER_Y = 438;

/** Ship speed in pixels per second. */
export const PLAYER_SPEED = 340;

/** Hull points the ship starts with. */
export const PLAYER_MAX_HULL = 3;

/** How long the ship ignores damage after a hit or a restore. */
export const PLAYER_INVULNERABLE_MS = 1_400;

/** How long the ship stays down after losing its hull before it is restored. */
export const PLAYER_RESTORE_MS = 1_600;

/** Enemy grid shape and footprint. */
export const ENEMY_ROWS = 3;
export const ENEMY_COLUMNS = 5;
export const ENEMY_WIDTH = 38;
export const ENEMY_HEIGHT = 26;
export const ENEMY_GAP_X = 26;
export const ENEMY_GAP_Y = 18;
export const ENEMY_TOP = 54;

/** Horizontal speed of the enemy formation, in pixels per second. */
export const ENEMY_SPEED = 46;

/** How far the formation drops when it reaches a wall. */
export const ENEMY_DROP = 16;

/** The formation stops dropping once its lowest row reaches this y. */
export const ENEMY_FLOOR = 300;

/** Time between enemy shots, in milliseconds. */
export const ENEMY_FIRE_INTERVAL_MS = 1_700;

/** Speed of enemy bullets, in pixels per second. */
export const ENEMY_BULLET_SPEED = 170;

/** Speed of the player's bullets, in pixels per second. */
export const PLAYER_BULLET_SPEED = 560;

/** Bullet footprint. */
export const BULLET_WIDTH = 5;
export const BULLET_HEIGHT = 14;

/** Pickup footprint and fall speed. */
export const PICKUP_SIZE = 26;
export const PICKUP_SPEED = 96;

/** Time between aimed shots while the shield test is armed. */
export const PROBE_INTERVAL_MS = 1_100;

/** Speed of the aimed shots fired at a shielded ship. */
export const PROBE_BULLET_SPEED = 230;

/** Damage the broken shield applies for each point of incoming damage. */
export const SHIELD_BUG_MULTIPLIER = 3;

/** Boss footprint and position. */
export const BOSS_WIDTH = 120;
export const BOSS_HEIGHT = 64;
export const BOSS_Y = 46;

/** A boss spawn slower than this counts as a stalled spawn. */
export const BOSS_SPAWN_BUDGET_MS = 2_000;

/** Simulated durations of each boss resource load, in milliseconds. */
export const LOAD_TEXTURES_MS = 1_200;
export const LOAD_SOUNDS_MS = 1_000;
export const LOAD_ANIMATIONS_MS = 1_800;
export const INIT_AI_MS = 500;

/** Longest frame the engine simulates in one step, so a stalled tab cannot teleport the ship. */
export const MAX_STEP_MS = 50;

/** Points shown in the HUD. They are fun feedback; Boothstrap awards the challenge's points. */
export const SCORE_ENEMY = 10;
export const SCORE_BUG_FOUND = 100;
export const SCORE_DIAGNOSIS_BASE = 300;
export const SCORE_HINT_COST = 100;
export const SCORE_DIAGNOSIS_FLOOR = 50;
export const SCORE_REPAIR_FIRST_TRY = 200;
export const SCORE_REPAIR_RETRY = 100;
export const SCORE_VERIFIED = 150;

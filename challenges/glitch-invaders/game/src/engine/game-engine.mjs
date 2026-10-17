import { tasksFor } from '../boss/boss-loader.mjs';

import { resolveShieldHit } from '../shield/shield.mjs';
import { fireWeapon, WeaponConfigError } from '../weapons/weapons.mjs';
import {
  BOSS_HEIGHT,
  BOSS_SPAWN_BUDGET_MS,
  BOSS_WIDTH,
  BOSS_Y,
  BULLET_HEIGHT,
  BULLET_WIDTH,
  ENEMY_BULLET_SPEED,
  ENEMY_COLUMNS,
  ENEMY_DROP,
  ENEMY_FIRE_INTERVAL_MS,
  ENEMY_FLOOR,
  ENEMY_GAP_X,
  ENEMY_GAP_Y,
  ENEMY_HEIGHT,
  ENEMY_ROWS,
  ENEMY_SPEED,
  ENEMY_TOP,
  ENEMY_WIDTH,
  MAX_STEP_MS,
  PICKUP_SIZE,
  PICKUP_SPEED,
  PLAYER_BULLET_SPEED,
  PLAYER_HEIGHT,
  PLAYER_INVULNERABLE_MS,
  PLAYER_MAX_HULL,
  PLAYER_RESTORE_MS,
  PLAYER_SPEED,
  PLAYER_WIDTH,
  PLAYER_Y,
  PROBE_BULLET_SPEED,
  PROBE_INTERVAL_MS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from './constants.mjs';
import { clamp, overlaps } from './geometry.mjs';

/** Boss health. */
const BOSS_HEALTH = 12;

/** The simulation. */
export class GameEngine {
  world;
  code;
  options;
  listeners = new Set();
  enemyFireAt = ENEMY_FIRE_INTERVAL_MS;
  probeFireAt = 0;
  jamSeen = false;
  shieldFailureSeen = false;

  constructor(options) {
    this.options = options;
    this.code = options.code;
    this.world = {
      time: 0,
      phase: 'ready',
      paused: false,
      wave: 1,
      incident: null,
      verifying: null,
      player: createPlayer(),
      enemies: [],
      bullets: [],
      pickups: [],
      boss: null,
      bossLoad: null,
      particles: [],
      kills: 0,
      formationDirection: 1,
    };
  }

  /** Listen for game events; returns the function that stops listening. */
  on(listener) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Begin the run at `wave`. Starting past an incident means that incident was already fixed, so its
   * trigger is marked as seen and the wave is not held back for it.
   */
  start(wave = 1) {
    if (this.world.phase !== 'ready') {
      return;
    }

    this.world.phase = 'playing';
    this.jamSeen = wave > 1;
    this.shieldFailureSeen = wave > 2;
    if (wave === 3) {
      this.world.wave = 3;
      this.startBossSpawn();

      return;
    }

    this.startWave(wave);
  }

  /**
   * Put the arena back into a frozen incident, as after a page refresh: the failure is already
   * recorded, so the Incident Console reopens on it.
   */
  restoreIncident(bug) {
    this.start(bug === 'weapon' ? 1 : 2);
    this.jamSeen = true;
    this.shieldFailureSeen = bug !== 'weapon';
    this.world.incident = bug;
    this.world.phase = 'frozen';

    switch (bug) {
      case 'weapon':
        this.world.player.weapon = 'fanout';
        break;
      case 'shield':
        this.world.player.hull = 0;
        break;
      case 'boss':
        this.world.wave = 3;
        this.world.enemies = [];
        this.world.boss = this.createBoss();
        break;
    }
  }

  /** Replace the game's code, as a correct patch does. */
  setCode(code) {
    this.code = code;
  }

  /** Stop simulating until {@link GameEngine.resume}. */
  pause() {
    this.world.paused = true;
  }

  /** Continue after {@link GameEngine.pause}. */
  resume() {
    this.world.paused = false;
  }

  /** Advance the simulation by `elapsedMs`, capped so a stalled frame cannot teleport anything. */
  update(elapsedMs, input) {
    const stepMs = Math.min(elapsedMs, MAX_STEP_MS);
    this.updateParticles(stepMs);
    if (this.world.paused || this.world.phase !== 'playing') {
      return;
    }

    this.world.time += stepMs;
    const seconds = stepMs / 1_000;
    this.updatePlayer(seconds, input);
    this.updateFormation(seconds);
    this.updateBoss(seconds);
    this.fireEnemyShots();
    this.moveBullets(seconds);
    this.movePickups(seconds);
    this.resolveBulletHits();
    this.collectPickups();
    this.checkWaveCleared();
  }

  /**
   * Skip ahead to the next incident: clear every plain drone and drop the carrier's pickup near the
   * ship. The player still has to collect it and trigger the failure.
   */
  fastForward() {
    if (this.world.phase !== 'playing') {
      return;
    }

    for (const enemy of this.world.enemies) {
      if (enemy.alive && enemy.kind === 'drone') {
        this.destroyEnemy(enemy);
      }
    }
    const carrier = this.world.enemies.find((enemy) => enemy.alive && enemy.kind !== 'drone');
    if (carrier !== undefined) {
      carrier.alive = false;
      this.burst(carrier.x + carrier.width / 2, carrier.y + carrier.height / 2, 'yellow');
      this.dropPickup(carrier.kind === 'weapon-carrier' ? 'fanout' : 'aegis');
    }
  }

  /**
   * Replay an incident with the repaired code so the participant sees it work. Resumes play and
   * emits `verification-passed` once the repaired behavior is observed.
   */
  beginVerification(bug) {
    this.world.incident = null;
    this.world.verifying = bug;
    this.world.phase = 'playing';
    this.world.bullets = this.world.bullets.filter((bullet) => bullet.owner === 'player');

    switch (bug) {
      case 'weapon':
        this.world.player.weapon = 'single';
        this.dropPickup('fanout');
        break;
      case 'shield':
        this.world.player.hull = PLAYER_MAX_HULL;
        this.world.player.shield = false;
        this.world.player.restoreAt = null;
        this.makeInvulnerable();
        this.dropPickup('aegis');
        break;
      case 'boss':
        this.world.boss = null;
        this.startBossSpawn();
        break;
    }
  }

  /** The run is over: freeze the arena for the completion screen. */
  finish() {
    this.world.phase = 'finished';
    this.emit({ type: 'run-finished' });
  }

  /** Put a new pickup above the ship, where it falls into reach. */
  dropPickup(kind) {
    const player = this.world.player;
    const offset = (this.options.random() - 0.5) * 160;
    this.world.pickups.push({
      kind,
      x: clamp(
        player.x + player.width / 2 - PICKUP_SIZE / 2 + offset,
        10,
        WORLD_WIDTH - PICKUP_SIZE - 10,
      ),
      y: -PICKUP_SIZE,
      width: PICKUP_SIZE,
      height: PICKUP_SIZE,
    });
    this.emit({ type: 'pickup-spawned', kind });
  }

  /** Lay out a formation of drones with one marked carrier. */
  startWave(wave) {
    const carrierKind = wave === 1 ? 'weapon-carrier' : 'shield-carrier';
    const carrierColumn = wave === 1 ? 2 : 1;
    const totalWidth = ENEMY_COLUMNS * ENEMY_WIDTH + (ENEMY_COLUMNS - 1) * ENEMY_GAP_X;
    const left = (WORLD_WIDTH - totalWidth) / 2;
    const enemies = [];

    for (let row = 0; row < ENEMY_ROWS; row += 1) {
      for (let column = 0; column < ENEMY_COLUMNS; column += 1) {
        const isCarrier = row === 1 && column === carrierColumn;
        enemies.push({
          x: left + column * (ENEMY_WIDTH + ENEMY_GAP_X),
          y: ENEMY_TOP + row * (ENEMY_HEIGHT + ENEMY_GAP_Y),
          width: ENEMY_WIDTH,
          height: ENEMY_HEIGHT,
          kind: isCarrier ? carrierKind : 'drone',
          row,
          alive: true,
        });
      }
    }

    this.world.wave = wave;
    this.world.enemies = enemies;
    this.world.formationDirection = 1;
    this.enemyFireAt = this.world.time + ENEMY_FIRE_INTERVAL_MS;
    this.emit({ type: 'wave-started', wave });
  }

  /** Move the ship and fire when asked. */
  updatePlayer(seconds, input) {
    const player = this.world.player;
    if (player.restoreAt !== null) {
      if (this.world.time >= player.restoreAt) {
        this.restorePlayer();
      }

      return;
    }

    const direction = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    player.x = clamp(
      player.x + direction * PLAYER_SPEED * seconds,
      8,
      WORLD_WIDTH - PLAYER_WIDTH - 8,
    );
    if (input.fire) {
      this.tryFire();
    }
  }

  /** Bring the ship back at full hull after a normal loss. */
  restorePlayer() {
    const player = this.world.player;
    player.hull = PLAYER_MAX_HULL;
    player.shield = false;
    player.restoreAt = null;
    this.makeInvulnerable();
    this.world.bullets = this.world.bullets.filter((bullet) => bullet.owner === 'player');
    this.emit({ type: 'ship-restored' });
  }

  /** Give the ship a short window where hits do nothing. */
  makeInvulnerable() {
    this.world.player.invulnerableUntil = this.world.time + PLAYER_INVULNERABLE_MS;
  }

  /** Fire the carried weapon, freezing the game on the first jam. */
  tryFire() {
    const player = this.world.player;
    let volley;

    try {
      volley = fireWeapon(this.code.weapons, player.weapon);
    } catch (error) {
      if (error instanceof WeaponConfigError) {
        this.jam(error);

        return;
      }
      throw error;
    }

    if (this.world.time - player.lastShotAt < volley.config.cooldownMs) {
      return;
    }

    player.lastShotAt = this.world.time;
    for (const shot of volley.shots) {
      this.world.bullets.push({
        x: player.x + player.width / 2 - BULLET_WIDTH / 2,
        y: player.y - BULLET_HEIGHT,
        width: BULLET_WIDTH,
        height: BULLET_HEIGHT,
        velocityX: Math.sin(shot.angle) * PLAYER_BULLET_SPEED,
        velocityY: -Math.cos(shot.angle) * PLAYER_BULLET_SPEED,
        owner: 'player',
        damage: shot.damage,
        homing: false,
      });
    }
    this.emit({ type: 'volley-fired', weapon: player.weapon, projectiles: volley.shots.length });

    if (
      this.world.verifying === 'weapon' &&
      player.weapon === 'fanout' &&
      volley.shots.length === 3
    ) {
      this.passVerification('weapon');
    }
  }

  /** The weapon had no configuration: stop the world on incident 1. */
  jam(error) {
    this.jamSeen = true;
    this.world.incident = 'weapon';
    this.world.phase = 'frozen';
    this.burst(this.world.player.x + PLAYER_WIDTH / 2, this.world.player.y, 'red', 18);
    this.emit({
      type: 'weapon-jammed',
      error,
      availableWeapons: Object.keys(this.code.weapons),
    });
  }

  /** Slide the formation and drop it at the walls. */
  updateFormation(seconds) {
    const alive = this.world.enemies.filter((enemy) => enemy.alive);
    if (alive.length === 0) {
      return;
    }

    const step = this.world.formationDirection * ENEMY_SPEED * seconds;
    let touchesWall = false;
    for (const enemy of alive) {
      enemy.x += step;
      if (enemy.x < 14 || enemy.x + enemy.width > WORLD_WIDTH - 14) {
        touchesWall = true;
      }
    }

    if (!touchesWall) {
      return;
    }

    this.world.formationDirection = this.world.formationDirection === 1 ? -1 : 1;
    const lowest = Math.max(...alive.map((enemy) => enemy.y + enemy.height));
    const drop = lowest + ENEMY_DROP <= ENEMY_FLOOR ? ENEMY_DROP : 0;
    for (const enemy of alive) {
      enemy.x -= step;
      enemy.y += drop;
    }
  }

  /** Move the boss side to side and let it shoot. */
  updateBoss(seconds) {
    const boss = this.world.boss;
    if (boss === null) {
      return;
    }

    const enraged = this.freeplay && boss.health <= boss.maxHealth / 2;
    const speedScale = enraged ? 1.5 : 1;
    boss.x += boss.velocityX * speedScale * seconds;
    if (boss.x < 10 || boss.x + boss.width > WORLD_WIDTH - 10) {
      boss.velocityX *= -1;
      boss.x = clamp(boss.x, 10, WORLD_WIDTH - boss.width - 10);
    }
    if (this.world.time >= boss.nextShotAt) {
      const centerX = boss.x + boss.width / 2;
      const muzzleY = boss.y + boss.height;
      if (this.freeplay) {
        boss.nextShotAt = this.world.time + (enraged ? 440 : 600);
        this.spawnBossVolley(centerX, muzzleY, enraged);
      } else {
        boss.nextShotAt = this.world.time + 900;
        this.spawnEnemyBullet(centerX, muzzleY, false);
      }
    }
  }

  /** Let a random front-line enemy fire, and keep the shield test supplied with aimed shots. */
  fireEnemyShots() {
    const world = this.world;
    const alive = world.enemies.filter((enemy) => enemy.alive);

    if (alive.length > 0 && world.time >= this.enemyFireAt) {
      this.enemyFireAt = world.time + ENEMY_FIRE_INTERVAL_MS;
      const shooter = alive[Math.floor(this.options.random() * alive.length)];
      if (shooter !== undefined) {
        this.spawnEnemyBullet(shooter.x + shooter.width / 2, shooter.y + shooter.height, false);
      }
    }

    const shieldTestArmed = world.player.shield && world.player.restoreAt === null;
    if (shieldTestArmed && world.time >= this.probeFireAt) {
      this.probeFireAt = world.time + PROBE_INTERVAL_MS;
      const source = alive[Math.floor(this.options.random() * alive.length)];
      const originX = source === undefined ? WORLD_WIDTH / 2 : source.x + source.width / 2;
      const originY = source === undefined ? ENEMY_TOP : source.y + source.height;
      this.spawnEnemyBullet(originX, originY, true);
    }
  }

  /** Add a bullet from `(x, y)`; probes are aimed at the ship, others fall straight down. */
  spawnEnemyBullet(x, y, aimed) {
    const player = this.world.player;
    let velocityX = 0;
    let velocityY = ENEMY_BULLET_SPEED;

    if (aimed) {
      const deltaX = player.x + player.width / 2 - x;
      const deltaY = player.y - y;
      const length = Math.hypot(deltaX, deltaY) || 1;
      velocityX = (deltaX / length) * PROBE_BULLET_SPEED;
      velocityY = (deltaY / length) * PROBE_BULLET_SPEED;
    }

    this.world.bullets.push({
      x: x - BULLET_WIDTH / 2,
      y,
      width: BULLET_WIDTH,
      height: BULLET_HEIGHT,
      velocityX,
      velocityY,
      owner: 'enemy',
      damage: 1,
      homing: aimed,
    });
  }

  /**
   * Move every bullet, steer homing ones to arrive where the ship is now, and drop those that leave
   * the arena. A ship that keeps still is always hit by the shield test's shot; one that moves can
   * still dodge.
   */
  moveBullets(seconds) {
    const player = this.world.player;
    const targetX = player.x + player.width / 2;
    for (const bullet of this.world.bullets) {
      if (bullet.homing && bullet.y < player.y && bullet.velocityY > 0) {
        const secondsToImpact = Math.max(0.05, (player.y - bullet.y) / bullet.velocityY);
        const neededVelocity = (targetX - (bullet.x + bullet.width / 2)) / secondsToImpact;
        bullet.velocityX = clamp(neededVelocity, -PROBE_BULLET_SPEED, PROBE_BULLET_SPEED);
      }
      bullet.x += bullet.velocityX * seconds;
      bullet.y += bullet.velocityY * seconds;
    }

    this.world.bullets = this.world.bullets.filter(
      (bullet) =>
        bullet.y > -BULLET_HEIGHT * 2 &&
        bullet.y < WORLD_HEIGHT + BULLET_HEIGHT &&
        bullet.x > -20 &&
        bullet.x < WORLD_WIDTH + 20,
    );
  }

  /** Let pickups fall, and send any that were missed back to the top so the incident can proceed. */
  movePickups(seconds) {
    for (const pickup of this.world.pickups) {
      pickup.y += PICKUP_SPEED * seconds;
      if (pickup.y > WORLD_HEIGHT) {
        pickup.y = -PICKUP_SIZE;
        pickup.x = 20 + this.options.random() * (WORLD_WIDTH - PICKUP_SIZE - 40);
      }
    }
  }

  /** Match player bullets against enemies and the boss, and enemy bullets against the ship. */
  resolveBulletHits() {
    const world = this.world;
    const spent = new Set();

    for (const bullet of world.bullets) {
      if (bullet.owner === 'player') {
        const enemy = world.enemies.find(
          (candidate) => candidate.alive && overlaps(bullet, candidate),
        );
        if (enemy !== undefined) {
          spent.add(bullet);
          this.destroyEnemy(enemy);
          continue;
        }

        const boss = world.boss;
        if (boss !== null && overlaps(bullet, boss)) {
          spent.add(bullet);
          boss.health -= bullet.damage;
          this.burst(bullet.x, bullet.y, 'red', 3);
          if (boss.health <= 0) {
            world.boss = null;
            world.kills += 5;
            this.burst(boss.x + boss.width / 2, boss.y + boss.height / 2, 'yellow', 36);
            if (this.freeplay) {
              this.finish();
            }
          }
        }
      } else if (world.player.restoreAt === null && overlaps(bullet, world.player)) {
        spent.add(bullet);
        this.hitPlayer(bullet.damage);
      }
    }

    if (spent.size > 0) {
      world.bullets = world.bullets.filter((bullet) => !spent.has(bullet));
    }
  }

  /** Remove an enemy, with a burst, and let a carrier drop its pickup. */
  destroyEnemy(enemy) {
    enemy.alive = false;
    this.world.kills += 1;
    this.burst(enemy.x + enemy.width / 2, enemy.y + enemy.height / 2, 'green');
    this.emit({ type: 'enemy-destroyed', kind: enemy.kind });

    if (enemy.kind === 'weapon-carrier' || enemy.kind === 'shield-carrier') {
      const kind = enemy.kind === 'weapon-carrier' ? 'fanout' : 'aegis';
      this.world.pickups.push({
        kind,
        x: enemy.x + (enemy.width - PICKUP_SIZE) / 2,
        y: enemy.y,
        width: PICKUP_SIZE,
        height: PICKUP_SIZE,
      });
      this.emit({ type: 'pickup-spawned', kind });
    }
  }

  /** Apply an enemy hit to the ship through the shield rules. */
  hitPlayer(incomingDamage) {
    const world = this.world;
    const player = world.player;
    if (world.time < player.invulnerableUntil) {
      return;
    }

    const shieldWasUp = player.shield;
    const hullBefore = player.hull;
    const outcome = resolveShieldHit(this.code.shield, player.shield, incomingDamage);
    if (outcome.shieldConsumed) {
      player.shield = false;
    }
    player.hull = Math.max(0, player.hull - outcome.actualDamage);
    this.burst(player.x + player.width / 2, player.y, shieldWasUp ? 'blue' : 'red', 10);

    if (shieldWasUp) {
      this.emit({
        type: 'shield-hit',
        incomingDamage,
        outcome,
        hullBefore,
        hullAfter: player.hull,
      });
    }

    if (player.hull <= 0) {
      this.loseHull(shieldWasUp);

      return;
    }

    this.makeInvulnerable();
    if (shieldWasUp && outcome.actualDamage === 0 && world.verifying === 'shield') {
      this.passVerification('shield');
    }
  }

  /** The hull hit zero: freeze on incident 2 if the shield caused it, otherwise restore shortly. */
  loseHull(shieldWasUp) {
    const world = this.world;
    this.burst(world.player.x + PLAYER_WIDTH / 2, world.player.y, 'red', 26);

    if (shieldWasUp && this.code.shield === 'amplify') {
      this.shieldFailureSeen = true;
      world.incident = 'shield';
      world.phase = 'frozen';
      this.emit({ type: 'ship-down', cause: 'shield-failure' });

      return;
    }

    if (this.freeplay) {
      this.emit({ type: 'ship-down', cause: 'damage' });
      this.finish();

      return;
    }

    world.player.restoreAt = world.time + PLAYER_RESTORE_MS;
    this.emit({ type: 'ship-down', cause: 'damage' });
  }

  /** Pick up anything the ship overlaps. */
  collectPickups() {
    const player = this.world.player;
    if (player.restoreAt !== null) {
      return;
    }

    const collected = this.world.pickups.filter((pickup) => overlaps(pickup, player));
    if (collected.length === 0) {
      return;
    }

    this.world.pickups = this.world.pickups.filter((pickup) => !collected.includes(pickup));
    for (const pickup of collected) {
      if (pickup.kind === 'fanout') {
        player.weapon = 'fanout';
      } else {
        player.shield = true;
        this.probeFireAt = this.world.time + 600;
      }
      this.burst(pickup.x + PICKUP_SIZE / 2, pickup.y + PICKUP_SIZE / 2, 'yellow', 10);
      this.emit({ type: 'pickup-collected', kind: pickup.kind });
    }
  }

  /**
   * End a wave once it is cleared and its incident has happened. If the player cleared the field
   * without triggering the incident, the pickup comes back so it still can. A repair that is still
   * being proven holds the next wave back, so the proof is never interrupted.
   */
  checkWaveCleared() {
    const world = this.world;
    const enemiesLeft = world.enemies.some((enemy) => enemy.alive);
    const waitingOnVerification = world.verifying !== null;
    if (
      world.phase !== 'playing' ||
      enemiesLeft ||
      world.pickups.length > 0 ||
      world.boss !== null ||
      world.wave === 3 ||
      waitingOnVerification
    ) {
      return;
    }

    if (world.wave === 1) {
      if (!this.jamSeen) {
        if (world.player.weapon !== 'fanout') {
          this.dropPickup('fanout');
        }

        return;
      }
      this.startWave(2);

      return;
    }

    if (!this.shieldFailureSeen) {
      if (!world.player.shield) {
        this.dropPickup('aegis');
      }

      return;
    }

    world.wave = 3;
    this.startBossSpawn();
  }

  /** Begin loading the boss's resources under the current code. */
  startBossSpawn() {
    const world = this.world;
    const strategy = this.code.bossLoad;
    world.phase = 'boss-loading';
    world.bossLoad = {
      strategy,
      startedAt: this.options.now(),
      tasks: tasksFor(strategy).map((task) => ({ name: task.name, startMs: null, endMs: null })),
    };
    this.emit({ type: 'boss-loading', strategy });

    void this.options
      .spawnBossResources(strategy, (event) => this.noteBossTask(event))
      .then((result) => this.bossArrived(result));
  }

  /** Record a load starting or finishing for the overlay. */
  noteBossTask(event) {
    const task = this.world.bossLoad?.tasks.find((candidate) => candidate.name === event.name);
    if (task === undefined) {
      return;
    }

    if (event.phase === 'start') {
      task.startMs = event.atMs;
    } else {
      task.endMs = event.atMs;
    }
  }

  /** The Monolith, centered at the top with full health. */
  createBoss() {
    return {
      x: (WORLD_WIDTH - BOSS_WIDTH) / 2,
      y: BOSS_Y,
      width: BOSS_WIDTH,
      height: BOSS_HEIGHT,
      health: BOSS_HEALTH,
      maxHealth: BOSS_HEALTH,
      velocityX: 70,
      nextShotAt: this.world.time + 1_200,
    };
  }

  /** The boss's resources are ready: show the boss, and freeze if the spawn stalled. */
  bossArrived(result) {
    const world = this.world;
    const stalled = result.totalMs > BOSS_SPAWN_BUDGET_MS;
    world.boss = this.createBoss();
    world.bossLoad = null;
    this.emit({ type: 'boss-online', result, stalled });

    if (stalled) {
      world.incident = 'boss';
      world.phase = 'frozen';

      return;
    }

    world.phase = 'playing';
    if (world.verifying === 'boss') {
      this.passVerification('boss');
    }
  }

  /** The repaired behavior was seen working. */
  passVerification(bug) {
    this.world.verifying = null;
    this.emit({ type: 'verification-passed', bug });
  }

  /** Spawn a short burst of particles. */
  burst(x, y, color, count = 8) {
    const scaled = Math.round(count * (this.options.particleScale ?? 1));
    for (let index = 0; index < scaled; index += 1) {
      const angle = this.options.random() * Math.PI * 2;
      const speed = 40 + this.options.random() * 140;
      this.world.particles.push({
        x,
        y,
        velocityX: Math.cos(angle) * speed,
        velocityY: Math.sin(angle) * speed,
        ageMs: 0,
        lifeMs: 300 + this.options.random() * 300,
        color,
      });
    }
  }

  /** Age particles and drop the expired ones. */
  updateParticles(stepMs) {
    const seconds = stepMs / 1_000;
    for (const particle of this.world.particles) {
      particle.ageMs += stepMs;
      particle.x += particle.velocityX * seconds;
      particle.y += particle.velocityY * seconds;
    }
    this.world.particles = this.world.particles.filter(
      (particle) => particle.ageMs < particle.lifeMs,
    );
  }

  /** Tell every listener about `event`. */
  emit(event) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  freeplay = false;

  /** Fire a spread volley (plus an aimed shot when enraged) from the boss during freeplay. */
  spawnBossVolley(centerX, muzzleY, enraged) {
    const speed = ENEMY_BULLET_SPEED * (enraged ? 1.45 : 1.25);
    const angles = enraged ? [-0.42, -0.2, 0, 0.2, 0.42] : [-0.32, 0, 0.32];
    for (const angle of angles) {
      this.world.bullets.push({
        x: centerX - BULLET_WIDTH / 2,
        y: muzzleY,
        width: BULLET_WIDTH,
        height: BULLET_HEIGHT,
        velocityX: Math.sin(angle) * speed,
        velocityY: Math.cos(angle) * speed,
        owner: 'enemy',
        damage: 1,
        homing: false,
      });
    }
    if (enraged) {
      this.spawnEnemyBullet(centerX, muzzleY, true);
    }
  }

  /** Resume play in the arena after the completion screen is dismissed for a boss showdown. */
  continuePlaying() {
    this.freeplay = true;
    this.jamSeen = true;
    this.shieldFailureSeen = true;
    this.world.incident = null;
    this.world.verifying = null;
    this.world.paused = false;
    this.world.phase = 'playing';
    this.world.wave = 3;
    this.world.enemies = [];
    this.world.pickups = [];
    this.world.bullets = [];
    this.world.player.hull = PLAYER_MAX_HULL;
    this.world.player.restoreAt = null;
    this.world.player.weapon = 'fanout';
    this.world.player.shield = true;
    this.world.boss = {
      ...this.createBoss(),
      health: BOSS_HEALTH * 3,
      maxHealth: BOSS_HEALTH * 3,
      velocityX: 140,
      nextShotAt: this.world.time + 500,
    };
  }
}

/** The ship, centered at the bottom with a full hull. */
function createPlayer() {
  return {
    x: (WORLD_WIDTH - PLAYER_WIDTH) / 2,
    y: PLAYER_Y,
    width: PLAYER_WIDTH,
    height: PLAYER_HEIGHT,
    hull: PLAYER_MAX_HULL,
    shield: false,
    weapon: 'single',
    invulnerableUntil: 0,
    restoreAt: null,
    lastShotAt: -Infinity,
  };
}

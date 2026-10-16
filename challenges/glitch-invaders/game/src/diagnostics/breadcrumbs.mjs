/** The most breadcrumbs the recorder keeps. */
const MAX_BREADCRUMBS = 40;

/** Keeps the latest breadcrumbs with game timestamps. */
export class BreadcrumbRecorder {
  entries = [];
  clock;

  constructor(clock) {
    this.clock = clock;
  }

  /** Record `breadcrumb` at the current game time. */
  add(breadcrumb) {
    this.entries.push({ ...breadcrumb, atMs: this.clock(), level: breadcrumb.level ?? 'info' });
    if (this.entries.length > MAX_BREADCRUMBS) {
      this.entries.shift();
    }
  }

  /** The recorded trail, oldest first. */
  trail() {
    return this.entries;
  }
}

/** Format how long before `failureAtMs` something happened, such as `-1.2 s`. */
export function formatOffset(failureAtMs, atMs) {
  const seconds = Math.max(0, failureAtMs - atMs) / 1_000;

  return seconds < 0.05 ? '0.0 s' : `-${seconds.toFixed(1)} s`;
}

/** Turn recorded breadcrumbs into console entries, with offsets measured from the failure. */
export function toBreadcrumbEntries(trail, failureAtMs, limit) {
  return trail.slice(-limit).map((crumb) => ({
    offsetLabel: formatOffset(failureAtMs, crumb.atMs),
    category: crumb.category,
    message: crumb.message,
    level: crumb.level,
    data: crumb.data ?? null,
  }));
}

/** Format a number of seconds for breadcrumb text, such as `4.5 s`. */
function secondsText(milliseconds) {
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

/** Subscribe `sink` to the engine's events, turning each into the breadcrumb a real service would log. */
export function attachBreadcrumbs(engine, sink) {
  return engine.on((event) => {
    switch (event.type) {
      case 'wave-started':
        sink.add({ category: 'game.wave', message: `Wave ${event.wave} started` });
        break;
      case 'pickup-collected':
        if (event.kind === 'fanout') {
          sink.add({
            category: 'game.weapon',
            message: 'Weapon selected: fanout',
            data: { weaponId: 'fanout' },
          });
        } else {
          sink.add({
            category: 'game.shield',
            message: 'Shield collected',
            data: { type: 'aegis' },
          });
          sink.add({
            category: 'game.shield',
            message: 'Shield enabled',
            data: { shieldActive: 'true' },
          });
        }
        break;
      case 'volley-fired':
        if (event.weapon !== 'single') {
          sink.add({
            category: 'game.weapon',
            message: `Fired ${event.weapon}`,
            data: { projectiles: String(event.projectiles) },
          });
        }
        break;
      case 'weapon-jammed':
        sink.add({
          category: 'game.weapon',
          message: `Firing weapon: ${event.error.weaponId}`,
          data: { weaponId: event.error.weaponId },
        });
        sink.add({
          category: 'game.weapon',
          message: 'Weapon fire failed: configuration missing',
          level: 'error',
          data: { availableWeapons: event.availableWeapons.join(', ') },
        });
        break;
      case 'shield-hit':
        sink.add({
          category: 'game.combat',
          message: `Incoming damage: ${event.incomingDamage}`,
          data: { damage: String(event.incomingDamage) },
        });
        sink.add({
          category: 'game.shield',
          message: 'Shield active: true',
          data: { shieldActive: 'true' },
        });
        sink.add({
          category: 'game.combat',
          message: `Actual damage applied: ${event.outcome.actualDamage}`,
          level: event.outcome.actualDamage === 0 ? 'info' : 'warning',
          data: { actualDamage: String(event.outcome.actualDamage), expected: '0' },
        });
        break;
      case 'ship-down':
        if (event.cause === 'shield-failure') {
          sink.add({
            category: 'game.combat',
            message: 'Ship destroyed: shield failed to protect',
            level: 'error',
          });
        }
        break;
      case 'boss-loading':
        sink.add({
          category: 'game.boss',
          message: 'Boss spawn initiated',
          data: { strategy: event.strategy },
        });
        break;
      case 'boss-online':
        sink.add({
          category: 'game.boss',
          message: `Boss ready after ${secondsText(event.result.totalMs)}`,
          level: event.stalled ? 'warning' : 'info',
        });
        break;
      case 'verification-passed':
        sink.add({ category: 'game.repair', message: `Repair verified: ${event.bug}` });
        break;
      case 'enemy-destroyed':
      case 'pickup-spawned':
      case 'ship-restored':
      case 'run-finished':
        break;
    }
  });
}

/** Draws the arena onto a canvas. It only reads the world; it never changes it. */
import { PLAYER_HEIGHT, PLAYER_Y, WORLD_HEIGHT, WORLD_WIDTH } from '../engine/constants.mjs';

import { PALETTE } from './palette.mjs';
import { DRONE_FRAMES, MONOLITH, SHIP } from './sprites.mjs';

/** The size of one sprite pixel, in world pixels. */
const DRONE_SCALE = 3;
const SHIP_SCALE = 3;
const MONOLITH_SCALE = 6;

/** Particle colors by name. */
const PARTICLE_COLORS = {
  red: PALETTE.danger,
  blue: PALETTE.accent,
  yellow: PALETTE.focus,
  green: PALETTE.success,
  white: PALETTE.fg,
};

/** Fixed star positions, so the backdrop never shifts between frames. */
const STARS = Array.from({ length: 46 }, (_, index) => ({
  x: (index * 97 + 31) % WORLD_WIDTH,
  y: (index * 53 + 17) % (PLAYER_Y - 20),
  phase: index * 0.7,
}));

/** The canvas renderer. */
export class CanvasRenderer {
  context;
  options;

  constructor(canvas, options) {
    const context = canvas.getContext('2d');
    if (context === null) {
      throw new Error('this browser cannot draw the game: no 2D canvas context');
    }

    const scale = Math.max(1, Math.ceil(window.devicePixelRatio || 1));
    canvas.width = WORLD_WIDTH * scale;
    canvas.height = WORLD_HEIGHT * scale;
    context.scale(scale, scale);
    context.imageSmoothingEnabled = false;
    this.context = context;
    this.options = options;
  }

  /** Draw one frame. */
  draw(world, nowMs) {
    this.drawBackdrop(nowMs);
    for (const pickup of world.pickups) {
      this.drawPickup(pickup, nowMs);
    }
    for (const enemy of world.enemies) {
      if (enemy.alive) {
        this.drawEnemy(enemy, nowMs);
      }
    }
    if (world.boss !== null) {
      this.drawBoss(world, nowMs);
    }
    this.drawBullets(world);
    this.drawPlayer(world, nowMs);
    this.drawParticles(world.particles);
  }

  /** The dark grid, a few stars, and the line the ship defends. */
  drawBackdrop(nowMs) {
    const context = this.context;
    context.fillStyle = PALETTE.bg;
    context.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    context.strokeStyle = 'rgba(95, 101, 112, 0.22)';
    context.lineWidth = 1;
    context.beginPath();
    for (let x = 0; x <= WORLD_WIDTH; x += 40) {
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, WORLD_HEIGHT);
    }
    for (let y = 0; y <= WORLD_HEIGHT; y += 40) {
      context.moveTo(0, y + 0.5);
      context.lineTo(WORLD_WIDTH, y + 0.5);
    }
    context.stroke();

    for (const star of STARS) {
      const twinkle = this.options.reducedMotion
        ? 0.6
        : 0.45 + 0.35 * Math.sin(nowMs / 700 + star.phase);
      context.fillStyle = `rgba(232, 234, 237, ${twinkle})`;
      context.fillRect(star.x, star.y, 2, 2);
    }

    const floorY = PLAYER_Y + PLAYER_HEIGHT + 10;
    context.strokeStyle = PALETTE.border;
    context.setLineDash([8, 6]);
    context.beginPath();
    context.moveTo(0, floorY + 0.5);
    context.lineTo(WORLD_WIDTH, floorY + 0.5);
    context.stroke();
    context.setLineDash([]);
    context.fillStyle = PALETTE.muted;
    context.font = '12px ui-monospace, Menlo, monospace';
    context.fillText('PROD', 10, floorY + 16);
  }

  /** Draw `sprite` at `(x, y)`, lit pixels in `color` and highlights in `highlight`. */
  drawSprite(sprite, x, y, scale, color, highlight) {
    const context = this.context;
    sprite.forEach((row, rowIndex) => {
      for (let column = 0; column < row.length; column += 1) {
        const pixel = row[column];
        if (pixel === '#' || pixel === 'o') {
          context.fillStyle = pixel === 'o' ? highlight : color;
          context.fillRect(x + column * scale, y + rowIndex * scale, scale, scale);
        }
      }
    });
  }

  /** A drone, with a marker above carriers: a gold diamond for the weapon, a blue shield for the aegis. */
  drawEnemy(enemy, nowMs) {
    const frame = DRONE_FRAMES[Math.floor(nowMs / 420) % DRONE_FRAMES.length] ?? DRONE_FRAMES[0];
    if (frame === undefined) {
      return;
    }

    const color = enemy.row === 1 ? PALETTE.warning : PALETTE.danger;
    const spriteWidth = (frame[0]?.length ?? 0) * DRONE_SCALE;
    const left = enemy.x + (enemy.width - spriteWidth) / 2;
    this.drawSprite(frame, left, enemy.y, DRONE_SCALE, color, PALETTE.bg);

    const centerX = enemy.x + enemy.width / 2;
    const pulse = this.options.reducedMotion ? 0 : Math.sin(nowMs / 250) * 1.5;
    if (enemy.kind === 'weapon-carrier') {
      this.drawDiamond(centerX, enemy.y - 9 - pulse, 7, PALETTE.focus);
    } else if (enemy.kind === 'shield-carrier') {
      this.drawShieldIcon(centerX, enemy.y - 10 - pulse, 8, PALETTE.accent);
    }
  }

  /** A filled diamond centered at `(x, y)`. */
  drawDiamond(x, y, radius, color) {
    const context = this.context;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(x, y - radius);
    context.lineTo(x + radius, y);
    context.lineTo(x, y + radius);
    context.lineTo(x - radius, y);
    context.closePath();
    context.fill();
  }

  /** A shield outline centered at `(x, y)`. */
  drawShieldIcon(x, y, size, color) {
    const context = this.context;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(x - size, y - size);
    context.lineTo(x + size, y - size);
    context.lineTo(x + size, y);
    context.lineTo(x, y + size);
    context.lineTo(x - size, y);
    context.closePath();
    context.fill();
    context.fillStyle = PALETTE.bg;
    context.fillRect(x - 2, y - size + 3, 4, 7);
  }

  /** A falling pickup: a gold chip with a fan of three lines, or a blue shield. */
  drawPickup(pickup, nowMs) {
    const context = this.context;
    const centerX = pickup.x + pickup.width / 2;
    const centerY = pickup.y + pickup.height / 2;
    const glow = this.options.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(nowMs / 200);

    if (pickup.kind === 'fanout') {
      context.fillStyle = `rgba(248, 185, 42, ${0.18 + glow * 0.18})`;
      context.fillRect(pickup.x - 5, pickup.y - 5, pickup.width + 10, pickup.height + 10);
      context.fillStyle = PALETTE.focus;
      context.fillRect(pickup.x, pickup.y, pickup.width, pickup.height);
      context.strokeStyle = PALETTE.bg;
      context.lineWidth = 3;
      context.beginPath();
      for (const dx of [-8, 0, 8]) {
        context.moveTo(centerX, centerY + 7);
        context.lineTo(centerX + dx, centerY - 7);
      }
      context.stroke();

      return;
    }

    context.fillStyle = `rgba(92, 156, 245, ${0.18 + glow * 0.18})`;
    context.fillRect(pickup.x - 5, pickup.y - 5, pickup.width + 10, pickup.height + 10);
    this.drawShieldIcon(centerX, centerY - 2, 13, PALETTE.accent);
  }

  /** The Monolith, with its health bar. */
  drawBoss(world, nowMs) {
    const boss = world.boss;
    if (boss === null) {
      return;
    }

    const rage = this.options.reducedMotion ? 0 : Math.sin(nowMs / 160) * 0.5 + 0.5;
    this.drawSprite(
      MONOLITH,
      boss.x,
      boss.y,
      MONOLITH_SCALE,
      PALETTE.mlhRed,
      rage > 0.5 ? PALETTE.focus : PALETTE.fg,
    );

    const context = this.context;
    const barWidth = boss.width;
    context.fillStyle = PALETTE.surface;
    context.fillRect(boss.x, boss.y - 12, barWidth, 6);
    context.fillStyle = PALETTE.danger;
    context.fillRect(boss.x, boss.y - 12, barWidth * Math.max(0, boss.health / boss.maxHealth), 6);
  }

  /** Every bullet: blue for the ship, gold for fan-out volleys, orange for aimed probes, red otherwise. */
  drawBullets(world) {
    const context = this.context;
    for (const bullet of world.bullets) {
      if (bullet.owner === 'player') {
        context.fillStyle = world.player.weapon === 'fanout' ? PALETTE.focus : PALETTE.accent;
      } else {
        context.fillStyle = bullet.homing ? PALETTE.warning : PALETTE.danger;
      }
      context.fillRect(bullet.x, bullet.y, bullet.width, bullet.height);
    }
  }

  /** The ship, its shield bubble, or its wreck. */
  drawPlayer(world, nowMs) {
    const context = this.context;
    const player = world.player;
    const centerX = player.x + player.width / 2;
    const centerY = player.y + player.height / 2;

    if (player.hull <= 0) {
      context.strokeStyle = PALETTE.danger;
      context.lineWidth = 4;
      context.beginPath();
      context.moveTo(centerX - 16, centerY - 12);
      context.lineTo(centerX + 16, centerY + 12);
      context.moveTo(centerX + 16, centerY - 12);
      context.lineTo(centerX - 16, centerY + 12);
      context.stroke();

      return;
    }

    const flickering = world.time < player.invulnerableUntil && !this.options.reducedMotion;
    context.globalAlpha = flickering && Math.floor(nowMs / 90) % 2 === 0 ? 0.35 : 1;
    this.drawSprite(SHIP, player.x, player.y, SHIP_SCALE, PALETTE.accent, PALETTE.fg);
    context.globalAlpha = 1;

    if (player.shield) {
      context.strokeStyle = PALETTE.accent;
      context.fillStyle = 'rgba(92, 156, 245, 0.16)';
      context.lineWidth = 3;
      context.beginPath();
      context.arc(centerX, centerY, 30, 0, Math.PI * 2);
      context.fill();
      context.stroke();
    }
  }

  /** The decorative bursts. */
  drawParticles(particles) {
    const context = this.context;
    for (const particle of particles) {
      context.globalAlpha = Math.max(0, 1 - particle.ageMs / particle.lifeMs);
      context.fillStyle = PARTICLE_COLORS[particle.color];
      context.fillRect(particle.x, particle.y, 4, 4);
    }
    context.globalAlpha = 1;
  }
}

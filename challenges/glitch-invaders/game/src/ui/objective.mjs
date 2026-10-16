/** Pick the objective for the current progress and arena. */
export function currentObjective(progress, world) {
  if (!progress.launched) {
    return { text: 'Press Start to launch your drone.', detail: '' };
  }
  if (progress.completed) {
    return { text: 'All three incidents are closed.', detail: 'Tell your guide what you found.' };
  }
  if (world.phase === 'frozen') {
    return { text: 'Open the evidence and find the cause.', detail: 'The game is paused.' };
  }
  if (world.phase === 'boss-loading') {
    return { text: 'The Monolith is spawning…', detail: 'Watch the loading steps.' };
  }

  switch (world.verifying) {
    case 'weapon':
      return {
        text: 'Catch the gold upgrade, then fire.',
        detail: 'Space fires. Three bolts means fixed.',
      };
    case 'shield':
      return {
        text: 'Catch the blue shield and take a hit.',
        detail: 'A fixed shield absorbs it.',
      };
    case 'boss':
      return { text: 'Watch the Monolith spawn.', detail: 'It should arrive fast now.' };
    case null:
      break;
  }

  return playingObjective(progress, world);
}

/** The objective while ordinary play is under way. */
function playingObjective(progress, world) {
  const { weapon, shield } = progress.bugs;
  const player = world.player;
  const hasPickup = (kind) => world.pickups.some((pickup) => pickup.kind === kind);

  if (weapon.stage === 'unseen') {
    if (player.weapon === 'fanout') {
      return { text: 'Fire your new upgrade.', detail: 'Press Space.' };
    }
    if (hasPickup('fanout')) {
      return { text: 'Catch the gold upgrade.', detail: 'Move under it.' };
    }

    return {
      text: 'Shoot the glitch marked with a gold diamond.',
      detail: 'It carries an upgrade.',
    };
  }

  if (shield.stage === 'unseen') {
    if (world.wave === 1 && !player.shield) {
      return { text: 'Clear the wave.', detail: 'A shielded glitch arrives next.' };
    }
    if (player.shield) {
      return { text: 'Test the shield: let a shot hit you.', detail: 'Stand in its path.' };
    }
    if (hasPickup('aegis')) {
      return { text: 'Catch the blue shield.', detail: 'Move under it.' };
    }

    return { text: 'Shoot the glitch marked with a blue shield.', detail: 'It carries a shield.' };
  }

  return { text: 'Clear the wave to call the Monolith.', detail: 'Keep shooting.' };
}

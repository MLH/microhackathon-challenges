/** The three failures, in play order. */
export const BUG_DEFINITIONS = {
  weapon: {
    id: 'weapon',
    incidentLabel: 'INC-1',
    title: 'Jammed weapon',
    lens: 'Stack traces',
    symptom: 'You grabbed the fan-out upgrade and your cannon stopped firing.',
    requiredSections: ['exception', 'stacktrace', 'context'],
    question: 'Why did the cannon jam?',
    options: [
      {
        id: 'no-ammo',
        text: 'The cannon ran out of ammo.',
        correct: false,
        feedback: 'Nothing in the evidence mentions ammo. Re-read the exception message.',
      },
      {
        id: 'missing-config',
        text: 'fire() looked up the fanout weapon and found no configuration for it.',
        correct: true,
        feedback: '',
      },
      {
        id: 'slow-cooldown',
        text: 'The single weapon has a cooldown that is far too long.',
        correct: false,
        feedback:
          'The single weapon fired fine before the upgrade. Compare what was requested with what exists.',
      },
    ],
    hints: [
      'Read the exception message first. It names exactly one thing.',
      'Compare attemptedWeapon with availableWeapons in the weapon_state context.',
      'fanout was requested, but only single exists. The configuration is missing.',
    ],
    fixExplanation:
      'Registering fanout gives fire() the entry it looks up: three projectiles, a 24° fan, and a 300 ms cooldown.',
    verifyPrompt: 'Collect the upgrade again and fire. Three bolts should leave the ship.',
  },
  shield: {
    id: 'shield',
    incidentLabel: 'INC-2',
    title: 'Friendly fire',
    lens: 'Breadcrumbs',
    symptom: 'The shield was up, one hit landed, and your ship was destroyed.',
    requiredSections: ['breadcrumbs', 'context'],
    question: 'What was the shield doing when the hit landed?',
    options: [
      {
        id: 'expired',
        text: 'It had already expired, so the hit did full damage.',
        correct: false,
        feedback: 'Check the breadcrumb that reports whether the shield was active.',
      },
      {
        id: 'amplified',
        text: 'It was active, but it multiplied the damage instead of absorbing it.',
        correct: true,
        feedback: '',
      },
      {
        id: 'never-equipped',
        text: 'The shield was never equipped.',
        correct: false,
        feedback: 'The first breadcrumbs show the pickup and the shield switching on.',
      },
    ],
    hints: [
      'Follow the breadcrumbs from the pickup to the destroyed ship.',
      'Compare "Actual damage applied" with the expected value in shield_state.',
      'The shield was active, yet damage was 3 where 0 was expected.',
    ],
    fixExplanation:
      'An active shield now sets the damage to 0 and is consumed, so a hit costs the ship nothing.',
    verifyPrompt: 'Collect the shield and let a shot hit you. The ship should survive untouched.',
  },
  boss: {
    id: 'boss',
    incidentLabel: 'INC-3',
    title: 'Boss buffering',
    lens: 'Performance tracing',
    symptom: 'The Monolith took far too long to appear. The game just sat there loading.',
    requiredSections: ['waterfall', 'context'],
    question: 'In the boss-spawn trace waterfall, which operation takes the longest?',
    options: [
      {
        id: 'load-textures',
        text: 'loadTextures',
        correct: false,
        feedback:
          'loadTextures takes 1.20 s. Look at the waterfall for an even longer bar (1.80 s).',
      },
      {
        id: 'load-animations',
        text: 'loadAnimations',
        correct: true,
        feedback: '',
      },
      {
        id: 'initialize-ai',
        text: 'initializeAI',
        correct: false,
        feedback:
          'initializeAI is the shortest bar at 500 ms. Look for the longest bar in the waterfall.',
      },
    ],
    hints: [
      'In the waterfall, the four loads run one after another. Which bar is longest?',
      'Compare the durations in the waterfall: loadTextures (1.20 s), loadSounds (1.00 s), loadAnimations (1.80 s), and initializeAI (500 ms).',
      'loadAnimations takes 1.80 s — the longest span in the trace.',
    ],
    fixExplanation:
      'Running core loads in parallel with Promise.all and streaming loadAnimations non-blocking cuts the spawn from 4.5 s to 1.2 s.',
    verifyPrompt: 'Watch the Monolith spawn again. It should arrive in about a second.',
  },
};

/** The failures in play order. */
export const BUG_ORDER = ['weapon', 'shield', 'boss'];

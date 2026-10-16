/**
 * The progress snapshot shared by the game page, the page server, and the monitor marker. It holds
 * only non-PII gameplay state, so the server can write it into the workspace for the guide.
 */

/** The three intentional failures, in play order. */
export const BUG_IDS = ['weapon', 'shield', 'boss'];

/** How far a participant has taken one failure. */
export const BUG_STAGES = ['unseen', 'encountered', 'investigated', 'repaired'];

/** The milestones the guide may forward to Boothstrap with `emit_event`. */
export const MILESTONE_NAMES = [
  'run-started',
  'bug-encountered',
  'evidence-viewed',
  'repair-attempted',
  'repair-succeeded',
  'challenge-completed',
];

/** Thrown when stored or received progress does not match the {@link Progress} shape. */
export class InvalidProgressError extends Error {
  constructor(reason) {
    super(`invalid progress: ${reason}`);
    this.name = 'InvalidProgressError';
  }
}

/** The largest request body the server accepts for a progress write. */
export const MAX_PROGRESS_BYTES = 16 * 1024;

/** A fresh, unplayed run. */
export function createProgress(attemptId, mode) {
  return {
    version: 1,
    attemptId,
    mode,
    launched: false,
    completed: false,
    score: 0,
    bugs: {
      weapon: createBugProgress(),
      shield: createBugProgress(),
      boss: createBugProgress(),
    },
    milestones: [],
  };
}

/** A failure the participant has not met yet. */
export function createBugProgress() {
  return {
    stage: 'unseen',
    evidenceViewed: false,
    hintsUsed: 0,
    diagnosisAttempts: 0,
    repairAttempts: 0,
  };
}

/** Whether `value` is one of `allowed`, narrowing it. */
function isOneOf(allowed, value) {
  return typeof value === 'string' && allowed.includes(value);
}

/** Read `key` from `record` as a non-negative integer, failing with the field's name. */
function readCount(record, key, path) {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new InvalidProgressError(`${path}.${key} must be a small non-negative integer`);
  }

  return value;
}

/** Read `key` from `record` as a boolean, failing with the field's name. */
function readFlag(record, key, path) {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new InvalidProgressError(`${path}.${key} must be a boolean`);
  }

  return value;
}

/** Narrow `value` to a plain object, failing with its path. */
function readRecord(value, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidProgressError(`${path} must be an object`);
  }

  return value;
}

/** Validate one failure's stored progress. */
function parseBugProgress(value, path) {
  const record = readRecord(value, path);
  const stage = record.stage;
  if (!isOneOf(BUG_STAGES, stage)) {
    throw new InvalidProgressError(`${path}.stage must be one of ${BUG_STAGES.join(', ')}`);
  }

  return {
    stage,
    evidenceViewed: readFlag(record, 'evidenceViewed', path),
    hintsUsed: readCount(record, 'hintsUsed', path),
    diagnosisAttempts: readCount(record, 'diagnosisAttempts', path),
    repairAttempts: readCount(record, 'repairAttempts', path),
  };
}

/** Validate one stored milestone. */
function parseMilestone(value, index) {
  const path = `milestones[${index}]`;
  const record = readRecord(value, path);
  const name = record.name;
  if (!isOneOf(MILESTONE_NAMES, name)) {
    throw new InvalidProgressError(`${path}.name is not a known milestone`);
  }

  const milestone = { seq: readCount(record, 'seq', path), name };
  if (record.bug !== undefined) {
    if (!isOneOf(BUG_IDS, record.bug)) {
      throw new InvalidProgressError(`${path}.bug is not a known bug`);
    }
    milestone.bug = record.bug;
  }
  if (record.correct !== undefined) {
    milestone.correct = readFlag(record, 'correct', path);
  }

  return milestone;
}

/**
 * Validate untrusted JSON as {@link Progress}.
 *
 * @throws {InvalidProgressError} when any field is missing or has the wrong type.
 */
export function parseProgress(value) {
  const record = readRecord(value, 'progress');
  if (record.version !== 1) {
    throw new InvalidProgressError('version must be 1');
  }
  if (typeof record.attemptId !== 'string' || !/^[a-z0-9-]{4,64}$/.test(record.attemptId)) {
    throw new InvalidProgressError(
      'attemptId must be 4 to 64 lowercase letters, digits, or hyphens',
    );
  }
  if (!isOneOf(['demo', 'live'], record.mode)) {
    throw new InvalidProgressError('mode must be demo or live');
  }
  const bugs = readRecord(record.bugs, 'bugs');
  if (!Array.isArray(record.milestones) || record.milestones.length > 200) {
    throw new InvalidProgressError('milestones must be a list of at most 200 entries');
  }

  return {
    version: 1,
    attemptId: record.attemptId,
    mode: record.mode,
    launched: readFlag(record, 'launched', 'progress'),
    completed: readFlag(record, 'completed', 'progress'),
    score: readCount(record, 'score', 'progress'),
    bugs: {
      weapon: parseBugProgress(bugs.weapon, 'bugs.weapon'),
      shield: parseBugProgress(bugs.shield, 'bugs.shield'),
      boss: parseBugProgress(bugs.boss, 'bugs.boss'),
    },
    milestones: record.milestones.map(parseMilestone),
  };
}

/**
 * The one line the monitor reads from the page's accessibility tree. Every field is a fixed word,
 * so the monitor never has to interpret prose.
 */
export function monitorStateLine(progress) {
  return [
    'glitch-state v1',
    `launched=${progress.launched ? 'yes' : 'no'}`,
    `weapon=${progress.bugs.weapon.stage}`,
    `shield=${progress.bugs.shield.stage}`,
    `boss=${progress.bugs.boss.stage}`,
    `completed=${progress.completed ? 'yes' : 'no'}`,
    `mode=${progress.mode}`,
  ].join(' ');
}

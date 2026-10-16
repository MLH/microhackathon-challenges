/**
 * Boss resource loading, with the inefficiencies that are the third intentional failure: the work
 * runs one task at a time, and one task repeats work already done at game start.
 */
import {
  INIT_AI_MS,
  LOAD_ANIMATIONS_MS,
  LOAD_SOUNDS_MS,
  LOAD_TEXTURES_MS,
} from '../engine/constants.mjs';

/** The span operation name every boss load reports under. */
export const LOAD_SPAN_OP = 'game.resource.load';

/** Every load a spawn can run, in the order the shipped code runs them. */
export const ALL_LOAD_TASKS = [
  { name: 'loadTextures', durationMs: LOAD_TEXTURES_MS },
  { name: 'loadSounds', durationMs: LOAD_SOUNDS_MS },
  { name: 'loadAnimations', durationMs: LOAD_ANIMATIONS_MS },
  { name: 'initializeAI', durationMs: INIT_AI_MS },
];

/** The loads `strategy` performs. Only `parallel-deduplicated` drops the redundant animation load. */
export function tasksFor(strategy) {
  if (strategy === 'parallel-deduplicated') {
    return ALL_LOAD_TASKS.filter((task) => task.name !== 'loadAnimations');
  }

  return ALL_LOAD_TASKS;
}

/** Whether `strategy` starts its loads together. */
export function runsInParallel(strategy) {
  return strategy === 'parallel-all' || strategy === 'parallel-deduplicated';
}

/**
 * How long a first spawn takes under `strategy`. A cache cannot help on a first spawn, so
 * `cached-sequential` costs the same as `sequential`.
 */
export function plannedLoadMs(strategy) {
  const durations = tasksFor(strategy).map((task) => task.durationMs);
  if (runsInParallel(strategy)) {
    return Math.max(...durations);
  }

  return durations.reduce((total, duration) => total + duration, 0);
}

/** Runs each load directly, recording nothing. */
export const runWithoutSpans = (_name, _operation, work) => work();

/** Run one load under the span runner, timing it against `startedAt`. */
async function runTask(task, options, startedAt, spans) {
  const runSpan = options.runSpan ?? runWithoutSpans;
  const startMs = options.now() - startedAt;
  options.onTask?.({ name: task.name, phase: 'start', atMs: startMs });

  await runSpan(task.name, LOAD_SPAN_OP, () => options.sleep(task.durationMs));

  const endMs = options.now() - startedAt;
  spans.push({ name: task.name, op: LOAD_SPAN_OP, startMs, durationMs: endMs - startMs });
  options.onTask?.({ name: task.name, phase: 'end', atMs: endMs });
}

/** Load the boss's resources as `options.strategy` dictates and report what actually ran. */
export async function loadBossResources(options) {
  const startedAt = options.now();
  const spans = [];
  const tasks = tasksFor(options.strategy);

  if (runsInParallel(options.strategy)) {
    await Promise.all(tasks.map((task) => runTask(task, options, startedAt, spans)));
  } else {
    for (const task of tasks) {
      await runTask(task, options, startedAt, spans);
    }
  }

  return { strategy: options.strategy, totalMs: options.now() - startedAt, spans };
}

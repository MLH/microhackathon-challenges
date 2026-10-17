/**
 * The Monolith's loading view: one bar per load, so the participant can watch the waterfall form
 * while the game waits, and feel the difference once it is repaired.
 */
import { ALL_LOAD_TASKS } from '../boss/boss-loader.mjs';
import { BOSS_SPAWN_BUDGET_MS } from '../engine/constants.mjs';

import { h, setText } from './dom.mjs';

/** Draws the loading panel from the world. */
export class BossLoadingView {
  element;
  rows = new Map();
  shownFor = null;
  clock = null;
  note = null;

  constructor(element) {
    this.element = element;
  }

  /** Show or hide the panel and refresh it for the current frame. */
  update(world, nowMs) {
    const load = world.bossLoad;
    if (world.phase !== 'boss-loading' || load === null) {
      if (!this.element.hidden) {
        this.element.hidden = true;
        this.shownFor = null;
      }

      return;
    }

    if (this.shownFor !== load.startedAt) {
      this.build(load.tasks.map((task) => task.name));
      this.shownFor = load.startedAt;
      this.element.hidden = false;
    }

    const elapsed = nowMs - load.startedAt;
    if (this.clock !== null) {
      setText(this.clock, `${(elapsed / 1_000).toFixed(1)} s`);
    }
    if (this.note !== null) {
      setText(
        this.note,
        elapsed > BOSS_SPAWN_BUDGET_MS
          ? `Buffering… over the ${(BOSS_SPAWN_BUDGET_MS / 1_000).toFixed(1)} s budget`
          : 'Loading resources',
      );
      this.note.dataset.over = String(elapsed > BOSS_SPAWN_BUDGET_MS);
    }
    for (const task of load.tasks) {
      const row = this.rows.get(task.name);
      if (row === undefined) {
        continue;
      }
      const fraction =
        task.endMs !== null
          ? 1
          : task.startMs === null
            ? 0
            : Math.min(1, (elapsed - task.startMs) / row.durationMs);
      row.fill.style.width = `${(fraction * 100).toFixed(1)}%`;
      setText(
        row.status,
        task.endMs !== null ? '✓ done' : task.startMs === null ? 'waiting' : 'loading',
      );
    }
  }

  /** Build one row per task. */
  build(names) {
    this.rows = new Map();
    this.clock = h('strong', { class: 'load-clock' }, '0.0 s');
    this.note = h('span', { class: 'load-note' }, 'Loading resources');
    const list = h('ul', { class: 'load-tasks', 'aria-label': 'Loading steps' });

    for (const name of names) {
      const fill = h('span', { class: 'load-fill' });
      const status = h('span', { class: 'load-status' }, 'waiting');
      list.append(
        h(
          'li',
          { class: 'load-task' },
          h('span', { class: 'load-name' }, name),
          h('span', { class: 'load-bar' }, fill),
          status,
        ),
      );
      const durationMs = ALL_LOAD_TASKS.find((task) => task.name === name)?.durationMs ?? 1_000;
      this.rows.set(name, { fill, status, durationMs });
    }

    this.element.replaceChildren(
      h('p', { class: 'load-head' }, 'Spawning the Monolith ', this.clock),
      this.note,
      list,
    );
  }
}

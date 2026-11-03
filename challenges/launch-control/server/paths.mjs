/**
 * Where an attempt keeps its files. Everything lives in the participant's workspace, which
 * Boothstrap provides fresh and removes afterwards; standalone, the current directory stands in.
 */
import path from 'node:path';

/** The package directory: where `challenge.json`, `ladder.json`, `page/`, and `server/` live. */
export const PACKAGE_DIR = path.resolve(import.meta.dirname, '..');

/** The booker's state for the guide to read when no monitor runs, as `SKILL.md` names it. */
export const STATE_FILE_NAME = 'travel-desk-state.json';

/** The fake itinerary `book_trip` writes, as `SKILL.md` names it. */
export const ITINERARY_FILE_NAME = 'itinerary.json';

/** Resolve the attempt's paths: `BOOTHSTRAP_WORKSPACE` inside Boothstrap, else `cwd`. */
export function resolveStatePaths(env, cwd) {
  const workspace = path.resolve(env.BOOTHSTRAP_WORKSPACE ?? cwd);
  const stateDir = path.join(workspace, '.launch-control');

  return {
    workspace,
    stateDir,
    runtimeConfigFile: path.join(stateDir, 'runtime-config.json'),
    pidFile: path.join(stateDir, 'server.pid'),
    stateFile: path.join(workspace, STATE_FILE_NAME),
    itineraryFile: path.join(workspace, ITINERARY_FILE_NAME),
  };
}

/**
 * Where an attempt keeps its files. Everything lives in the participant's workspace, which
 * Boothstrap provides fresh and removes afterwards; standalone, the current directory stands in.
 */
import path from 'node:path';

/** The name of the progress file, which `SKILL.md` tells the guide to read. */
export const PROGRESS_FILE_NAME = 'glitch-progress.json';

/** Resolve the attempt's paths: `BOOTHSTRAP_WORKSPACE` inside Boothstrap, else `cwd`. */
export function resolveStatePaths(env, cwd) {
  const workspace = path.resolve(env.BOOTHSTRAP_WORKSPACE ?? cwd);
  const stateDir = path.join(workspace, '.glitch');

  return {
    workspace,
    stateDir,
    runtimeConfigFile: path.join(stateDir, 'runtime-config.json'),
    pidFile: path.join(stateDir, 'server.pid'),
    progressFile: path.join(workspace, PROGRESS_FILE_NAME),
  };
}

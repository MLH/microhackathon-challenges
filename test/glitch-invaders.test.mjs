// Proves the glitch-invaders package: the three intentional failures trigger
// through gameplay and verify their repairs in play; stack frames match the
// real source lines; the IncidentTracker enforces stage progression; the page
// server serves native .mjs modules under a strict CSP, enforces origin, host,
// size, and path checks, and refuses a planted progress file; and the setup and
// cleanup hooks start and stop the server cleanly, including after failures.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { codeForProgress } from '../challenges/glitch-invaders/game/src/app/resume.mjs';
import { loadBossResources } from '../challenges/glitch-invaders/game/src/boss/boss-loader.mjs';
import {
  CORRECT_PATCH_IDS,
  createBrokenCodeState,
  REPAIR_PATCHES,
  tryRepair,
} from '../challenges/glitch-invaders/game/src/bugs/code-state.mjs';
import {
  IllegalBugTransitionError,
  IncidentTracker,
} from '../challenges/glitch-invaders/game/src/bugs/incident-tracker.mjs';
import { WEAPON_STACK_FRAMES } from '../challenges/glitch-invaders/game/src/diagnostics/evidence-builders.mjs';
import { SimulatedEvidenceProvider } from '../challenges/glitch-invaders/game/src/diagnostics/simulated-evidence.mjs';
import {
  BOSS_SPAWN_BUDGET_MS,
  PLAYER_MAX_HULL,
  PLAYER_SPEED,
  SHIELD_BUG_MULTIPLIER,
  WORLD_WIDTH,
} from '../challenges/glitch-invaders/game/src/engine/constants.mjs';
import { GameEngine } from '../challenges/glitch-invaders/game/src/engine/game-engine.mjs';
import { createRandom } from '../challenges/glitch-invaders/game/src/engine/random.mjs';
import { idleInput } from '../challenges/glitch-invaders/game/src/engine/world.mjs';
import { HttpProgressStore } from '../challenges/glitch-invaders/game/src/session/progress-store.mjs';
import { WeaponConfigError } from '../challenges/glitch-invaders/game/src/weapons/weapons.mjs';
import { runCleanup } from '../challenges/glitch-invaders/server/cleanup.mjs';
import { resolveStatePaths } from '../challenges/glitch-invaders/server/paths.mjs';
import { runSetup } from '../challenges/glitch-invaders/server/setup.mjs';
import { BUG_IDS, createProgress, monitorStateLine } from '../challenges/glitch-invaders/shared/progress.mjs';

const runFile = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.join(testDirectory, '..', 'challenges', 'glitch-invaders');
const FRAME_MS = 16;
const SERVER_EXIT_TIMEOUT_MS = 5_000;
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'";

/** Fake time for the boss loader, which needs `now` and `sleep`. */
class VirtualClock {
  constructor() {
    this.time = 0;
    this.timers = [];
  }

  /** The current virtual time in milliseconds. */
  now = () => this.time;

  /** Resolve after `milliseconds` of virtual time. */
  sleep = (milliseconds) =>
    new Promise((resolve) => {
      this.timers.push({ at: this.time + milliseconds, resolve });
    });

  /** Move time forward, firing each timer at its moment and letting its continuations run. */
  async advance(milliseconds) {
    const target = this.time + milliseconds;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.at <= target)
        .sort((first, second) => first.at - second.at)[0];
      if (due === undefined) {
        break;
      }
      this.timers = this.timers.filter((timer) => timer !== due);
      this.time = due.at;
      due.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    }
    this.time = target;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Create an engine with the shipped, broken code unless told otherwise. */
function createHarness(code = createBrokenCodeState(), seed = 7) {
  const clock = new VirtualClock();
  const engine = new GameEngine({
    random: createRandom(seed),
    code,
    spawnBossResources: (strategy, onTask) =>
      loadBossResources({
        strategy,
        sleep: clock.sleep,
        now: clock.now,
        onTask,
      }),
    now: clock.now,
    particleScale: 0,
  });
  const events = [];
  engine.on((event) => events.push(event));
  const input = idleInput();

  const run = (milliseconds) => {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += FRAME_MS) {
      engine.update(FRAME_MS, input);
    }
  };

  return {
    engine,
    clock,
    events,
    input,
    run,
    collect: (kind) => {
      const collected = () =>
        kind === 'fanout' ? engine.world.player.weapon === 'fanout' : engine.world.player.shield;
      for (let frame = 0; frame < 900 && !collected(); frame += 1) {
        const pickup = engine.world.pickups.find((candidate) => candidate.kind === kind);
        if (pickup !== undefined) {
          engine.world.player.x = pickup.x - 7;
        }
        engine.update(FRAME_MS, input);
      }
      if (!collected()) {
        throw new Error(`the ${kind} pickup was never collected`);
      }
    },
    eventsOf: (type) => events.filter((event) => event.type === type),
  };
}

/** A code state where `bugs` have been repaired with their correct patches. */
function repaired(...bugs) {
  const progress = createProgress('test-attempt');
  for (const bug of bugs) {
    progress.bugs[bug].stage = 'repaired';
  }

  return codeForProgress(progress);
}

/** Ask the OS for a free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Make a fresh temporary directory that `testContext` removes when the test ends. */
async function makeTemporaryDirectory(testContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'glitch-test-'));
  testContext.after(() => rm(directory, { recursive: true, force: true }));

  return directory;
}

/** The environment a hook sees for `workspace` on `port`, with nothing else from this process. */
function hookEnvironment(workspace, port) {
  return { PATH: process.env.PATH, BOOTHSTRAP_WORKSPACE: workspace, GLITCH_PORT: String(port) };
}

/** Run the package's `hook` (setup or cleanup) to completion and resolve with its exit code, output, and pid. */
function runHook(hook, env, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(packageDirectory, hook), [], {
      ...options,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr, pid: child.pid }));
  });
}

/** Make a workspace whose cleanup hook runs in teardown, so no server outlives the test. */
async function makeWorkspace(testContext, port) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'glitch-hooks-'));
  testContext.after(async () => {
    await runHook('cleanup', hookEnvironment(workspace, port));
    await rm(workspace, { recursive: true, force: true });
  });

  return workspace;
}

/** Start a server on `port` that answers every request with `body`, closed when the test ends. */
function holdPort(testContext, port, body) {
  return new Promise((resolve, reject) => {
    const server = createHttpServer((_request, response) => response.end(body));
    testContext.after(
      () =>
        new Promise((done) => {
          server.close(done);
          server.closeAllConnections();
        }),
    );
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

/** The text `/` answers with on `port`. */
async function pageText(port) {
  return (await fetch(`http://127.0.0.1:${port}/`)).text();
}

/** Whether connecting to `port` is refused. */
async function isRefused(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
  } catch (error) {
    return error.cause?.code === 'ECONNREFUSED';
  }

  return false;
}

/** Poll until connecting to `port` is refused, failing the test if it never is. */
async function waitUntilRefused(port) {
  const deadline = Date.now() + SERVER_EXIT_TIMEOUT_MS;
  while (!(await isRefused(port))) {
    assert.ok(Date.now() < deadline, `port ${port} still accepts connections`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The page server's pid, from the pid file setup wrote in `workspace`. */
async function readServerPid(workspace) {
  return Number((await readFile(path.join(workspace, '.glitch', 'server.pid'), 'utf8')).trim());
}

/** Read one column of `ps` for `pid`, such as `pgid`. */
async function readProcessColumn(column, pid) {
  const { stdout } = await runFile('ps', ['-o', `${column}=`, '-p', String(pid)]);

  return stdout.trim();
}

/** Run setup for a new attempt in a fresh temporary workspace and register cleanup on `testContext`. */
async function startStack(testContext, extraEnv = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'glitch-ws-'));
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    BOOTHSTRAP_WORKSPACE: workspace,
    BOOTHSTRAP_STATION_ID: 'test-station',
    BOOTHSTRAP_SESSION_ID: 'test-session',
    GLITCH_PORT: String(port),
    ...extraEnv,
  };
  const paths = resolveStatePaths(env, workspace);
  const result = await runSetup(env, workspace);
  const stop = async () => {
    await runCleanup(paths);
    await rm(workspace, { recursive: true, force: true });
  };
  testContext.after(stop);

  return { ...result, paths, env, stop };
}

/** Whether process `pid` is running. */
function alive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

/** Whether something answers on `port`. */
async function answers(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
  } catch {
    return false;
  }
}

/**
 * GET `requestPath` from the server at `url` exactly as written, since `fetch` would normalize dot
 * segments away; `headers` may replace the Host. Resolves with the status, headers, and text.
 */
function getRaw(url, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const { hostname, port, host } = new URL(url);
    const probe = request(
      { hostname, port, path: requestPath, headers: { host, ...headers } },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, text }),
        );
      },
    );
    probe.once('error', reject);
    probe.end();
  });
}

/** PUT `body` as JSON to the progress endpoint of the server at `url`; `headers` add or replace. */
function putProgressTo(url, body, headers = {}) {
  return fetch(`${url}api/progress`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

test('weapon stack trace frames point at the real lines of the calls they name', () => {
  const callAtLine = {
    fireWeapon: 'throw new WeaponConfigError',
    'GameEngine.tryFire': 'fireWeapon(',
    'GameEngine.updatePlayer': 'this.tryFire()',
    'GameEngine.update': 'this.updatePlayer(',
    'GameLoop.frame': 'this.engine.update(',
  };

  const inApp = WEAPON_STACK_FRAMES.filter((frame) => frame.inApp);
  assert.equal(inApp.length, Object.keys(callAtLine).length);

  for (const frame of inApp) {
    const source = readFileSync(path.join(packageDirectory, frame.file), 'utf8');
    const text = source.split('\n')[frame.line - 1] ?? '';
    assert.ok(
      text.includes(callAtLine[frame.functionName]),
      `${frame.functionName} at ${frame.file}:${frame.line} did not contain ${callAtLine[frame.functionName]}`,
    );
  }
});

test('ships all three bugs broken and only accepts the single correct patch for each', () => {
  const broken = createBrokenCodeState();
  assert.equal(broken.weapons.fanout, undefined);
  assert.equal(broken.shield, 'amplify');
  assert.equal(broken.bossLoad, 'sequential');

  for (const bug of BUG_IDS) {
    const passing = REPAIR_PATCHES[bug].filter(
      (patch) => tryRepair(bug, patch.id, createBrokenCodeState()).check.ok,
    );
    assert.deepEqual(
      passing.map((patch) => patch.id),
      [CORRECT_PATCH_IDS[bug]],
    );
    assert.notEqual(REPAIR_PATCHES[bug][0]?.id, CORRECT_PATCH_IDS[bug]);

    for (const patch of REPAIR_PATCHES[bug].filter((candidate) => candidate.id !== CORRECT_PATCH_IDS[bug])) {
      const trial = tryRepair(bug, patch.id, broken);
      assert.equal(trial.check.ok, false);
      assert.ok(trial.check.observation.length > 0);
      assert.equal(trial.state, broken);
    }

    const fixed = tryRepair(bug, CORRECT_PATCH_IDS[bug], createBrokenCodeState());
    assert.equal(fixed.check.ok, true);
    assert.notDeepEqual(fixed.state, createBrokenCodeState());
  }

  assert.throws(
    () => tryRepair('weapon', 'shield-absorbs-hit', createBrokenCodeState()),
    /unknown patch/,
  );
});

test('moves the ship within bounds and fires the single weapon at its cooldown rate', () => {
  const { engine, input, run, eventsOf } = createHarness();
  engine.start(1);
  const startX = engine.world.player.x;
  input.right = true;
  run(500);
  assert.ok(Math.abs(engine.world.player.x - startX - PLAYER_SPEED * 0.5) < 15);

  input.right = false;
  input.left = true;
  run(3_000);
  assert.ok(engine.world.player.x >= 0);

  input.left = false;
  input.right = true;
  input.fire = true;
  run(1_000);
  assert.ok(engine.world.player.x + engine.world.player.width <= WORLD_WIDTH);

  const shots = eventsOf('volley-fired');
  assert.ok(shots.length >= 4 && shots.length <= 5);
  assert.ok(shots.every((shot) => shot.weapon === 'single' && shot.projectiles === 1));
});

test('incident 1: the weapon upgrade jams with WeaponConfigError and fires three bolts once repaired', () => {
  const { engine, input, run, collect, eventsOf } = createHarness();
  engine.start(1);
  engine.fastForward();
  collect('fanout');
  assert.equal(engine.world.player.weapon, 'fanout');

  input.fire = true;
  run(100);

  const [jam] = eventsOf('weapon-jammed');
  assert.ok(jam?.error instanceof WeaponConfigError);
  assert.equal(jam?.error.message, 'Configuration missing for weapon: fanout');
  assert.deepEqual(jam?.availableWeapons, ['single']);
  assert.equal(engine.world.phase, 'frozen');
  assert.equal(engine.world.incident, 'weapon');

  engine.setCode(repaired('weapon'));
  engine.beginVerification('weapon');
  engine.world.player.weapon = 'single';
  collect('fanout');
  run(1_000);

  const volleys = eventsOf('volley-fired').filter((event) => event.weapon === 'fanout');
  assert.equal(volleys[0]?.projectiles, 3);
  assert.deepEqual(
    eventsOf('verification-passed').map((event) => event.bug),
    ['weapon'],
  );
});

test('incident 2: the shield amplifies damage until repaired, then absorbs the hit', () => {
  const { engine, run, collect, eventsOf } = createHarness();
  engine.start(2);
  engine.fastForward();
  collect('aegis');
  run(10_000);

  const [hit] = eventsOf('shield-hit');
  assert.equal(hit?.incomingDamage, 1);
  assert.equal(hit?.outcome.actualDamage, SHIELD_BUG_MULTIPLIER);
  assert.equal(hit?.hullBefore, PLAYER_MAX_HULL);
  assert.equal(hit?.hullAfter, 0);
  assert.equal(engine.world.incident, 'shield');

  engine.setCode(repaired('shield'));
  engine.beginVerification('shield');
  collect('aegis');
  run(10_000);

  const hits = eventsOf('shield-hit');
  assert.equal(hits.at(-1)?.outcome.actualDamage, 0);
  assert.equal(engine.world.player.hull, PLAYER_MAX_HULL);
  assert.ok(eventsOf('verification-passed').some((event) => event.bug === 'shield'));
});

test('incident 3: the boss spawn stalls sequentially, then finishes within budget once repaired', async () => {
  const { engine, clock, eventsOf } = createHarness();
  engine.start(3);
  assert.equal(engine.world.phase, 'boss-loading');
  await clock.advance(5_000);

  const [online] = eventsOf('boss-online');
  assert.equal(online?.stalled, true);
  assert.equal(online?.result.totalMs, 4_500);
  assert.deepEqual(
    online?.result.spans.map((span) => span.name),
    ['loadTextures', 'loadSounds', 'loadAnimations', 'initializeAI'],
  );
  assert.equal(engine.world.incident, 'boss');

  const code = tryRepair('boss', 'parallel-without-redundant-load', createBrokenCodeState());
  engine.setCode(code.state);
  engine.beginVerification('boss');
  await clock.advance(1_500);

  const verified = eventsOf('boss-online')[1];
  assert.equal(verified?.stalled, false);
  assert.ok(verified.result.totalMs <= BOSS_SPAWN_BUDGET_MS);
  assert.ok(!verified.result.spans.some((span) => span.name === 'loadAnimations'));
  assert.deepEqual(
    eventsOf('verification-passed').map((event) => event.bug),
    ['boss'],
  );
});

test('continues into a tougher boss showdown after completion and finishes when defeated', async () => {
  const { engine, clock, input, run } = createHarness(repaired('weapon', 'shield', 'boss'));
  engine.start(3);
  await clock.advance(1_500);
  engine.finish();
  assert.equal(engine.world.phase, 'finished');

  engine.continuePlaying();
  assert.equal(engine.world.phase, 'playing');
  assert.equal(engine.world.player.weapon, 'fanout');
  assert.equal(engine.world.player.shield, true);
  assert.equal(engine.world.boss?.maxHealth, 36);

  run(600);
  assert.ok(engine.world.bullets.filter((bullet) => bullet.owner === 'enemy').length >= 3);

  engine.world.boss.health = 1;
  engine.world.player.x = engine.world.boss.x + engine.world.boss.width / 2 - 20;
  input.fire = true;
  run(2_000);

  assert.equal(engine.world.boss, null);
  assert.equal(engine.world.phase, 'finished');
});

test('IncidentTracker enforces stage order, numbers milestones once, and formats the state marker', () => {
  const tracker = new IncidentTracker(createProgress('test-attempt'));
  const correctDiagnosis = {
    weapon: 'missing-config',
    shield: 'amplified',
    boss: 'load-animations',
  };

  assert.throws(() => tracker.markEvidenceViewed('shield'), IllegalBugTransitionError);

  tracker.launch();
  tracker.launch();

  for (const bug of BUG_IDS) {
    tracker.encounter(bug);
    tracker.markEvidenceViewed(bug);
    assert.equal(tracker.answerDiagnosis(bug, correctDiagnosis[bug]).correct, true);
    tracker.recordRepairAttempt(bug, true);
    tracker.markRepaired(bug);
  }

  const progress = tracker.snapshot();
  assert.equal(progress.completed, true);
  assert.equal(progress.milestones.at(-1)?.name, 'challenge-completed');
  assert.equal(
    monitorStateLine(progress),
    'glitch-state v1 launched=yes weapon=repaired shield=repaired boss=repaired completed=yes mode=demo',
  );
});

test('SimulatedEvidenceProvider builds labelled evidence with a stack trace for the weapon jam', async () => {
  const weaponEncounter = {
    bug: 'weapon',
    jam: {
      weaponId: 'fanout',
      availableWeapons: ['single'],
      error: new Error('Configuration missing for weapon: fanout'),
    },
  };

  const simulated = await new SimulatedEvidenceProvider().evidenceFor(weaponEncounter);

  assert.equal(simulated.source, 'simulated');
  assert.equal(simulated.bug, 'weapon');
  assert.ok(simulated.sections.some((section) => section.kind === 'stacktrace'));
});

test('the page server serves native .mjs modules, stores progress, and refuses cross-origin or invalid writes', async (testContext) => {
  const stack = await startStack(testContext);
  const base = stack.url.replace(/\/$/, '');
  const putProgress = (body, headers = {}) => putProgressTo(stack.url, body, headers);

  assert.equal((await fetch(`${base}/healthz`)).status, 200);

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('boothstrap-state'));

  const moduleResponse = await fetch(`${base}/src/main.mjs`);
  assert.equal(moduleResponse.status, 200);
  assert.match(moduleResponse.headers.get('content-type') ?? '', /text\/javascript/);

  const sharedResponse = await fetch(`${base}/shared/progress.mjs`);
  assert.equal(sharedResponse.status, 200);
  assert.match(sharedResponse.headers.get('content-type') ?? '', /text\/javascript/);

  const config = await (await fetch(`${base}/runtime-config.json`)).json();
  assert.deepEqual(config, { attemptId: stack.attemptId });

  const progress = createProgress(stack.attemptId);
  progress.launched = true;
  assert.equal((await putProgress(JSON.stringify(progress))).status, 204);

  const stored = await (await fetch(`${base}/api/progress`)).json();
  assert.equal(stored.launched, true);
  assert.equal(JSON.parse(await readFile(stack.paths.progressFile, 'utf8')).launched, true);

  const other = createProgress('another-attempt');
  assert.equal((await putProgress(JSON.stringify(other))).status, 409);
  assert.equal((await putProgress('{"version":1}')).status, 400);
  assert.equal((await putProgress('not json')).status, 400);
  assert.equal((await putProgress('{}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await putProgress('x'.repeat(20_000))).status, 413);
  assert.equal(
    (await putProgress(JSON.stringify(progress), { origin: 'https://evil.example' })).status,
    403,
  );
  assert.equal((await getRaw(stack.url, '/healthz', { host: 'evil.example' })).status, 403);
  assert.equal((await fetch(`${base}/..%2F..%2Fchallenge.json`)).status, 404);

  assert.equal((await fetch(`${base}/api/progress`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${base}/api/progress`)).status, 204);
});

test('the shipped setup and cleanup hooks start and stop the server and clean up workspace state', async (testContext) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'glitch-hooks-'));
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    BOOTHSTRAP_WORKSPACE: workspace,
    BOOTHSTRAP_PACKAGE_DIR: packageDirectory,
    GLITCH_PORT: String(port),
  };
  testContext.after(async () => {
    await runFile(path.join(packageDirectory, 'cleanup'), [], { cwd: workspace, env }).catch(
      () => undefined,
    );
    await rm(workspace, { recursive: true, force: true });
  });

  const setup = await runFile(path.join(packageDirectory, 'setup'), [], { cwd: workspace, env });
  const pid = Number((await readFile(path.join(workspace, '.glitch', 'server.pid'), 'utf8')).trim());
  assert.ok(setup.stdout.includes(`http://127.0.0.1:${port}/`));
  assert.equal(await answers(port), true);
  assert.equal(alive(pid), true);

  await runFile(path.join(packageDirectory, 'cleanup'), [], { cwd: workspace, env });
  await runFile(path.join(packageDirectory, 'cleanup'), [], { cwd: workspace, env });

  assert.equal(alive(pid), false);
  assert.equal(await answers(port), false);
  assert.equal(existsSync(path.join(workspace, '.glitch')), false);
});

test('the page server sends the CSP on the page and on an error response', async (testContext) => {
  const stack = await startStack(testContext);

  const page = await getRaw(stack.url, '/');
  const missing = await getRaw(stack.url, '/no-such-file.mjs');

  assert.equal(page.status, 200);
  assert.equal(page.headers['content-security-policy'], CONTENT_SECURITY_POLICY);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers['content-security-policy'], CONTENT_SECURITY_POLICY);
});

test('a refused progress save reports the failure instead of swallowing it', async () => {
  const errors = [];
  const store = new HttpProgressStore(
    '/api/progress',
    async () => new Response('refused', { status: 422 }),
    (error) => errors.push(error.message),
  );

  await store.save(createProgress('attempt-1'));

  assert.deepEqual(errors, ['progress save failed with status 422']);
});

test('the game page has no inline styles or inline scripts for the CSP to block', async () => {
  const page = await readFile(path.join(packageDirectory, 'game', 'index.html'), 'utf8');

  assert.doesNotMatch(page, /<style|style=/);
  assert.doesNotMatch(page, /<script(?![^>]*\ssrc=)[^>]*>/);
  assert.doesNotMatch(page, /\son[a-z]+=/);
});

for (const requestPath of [
  '/%2e%2e/challenge.json',
  '/%2e%2e/server/setup.mjs',
  '/shared/%2e%2e/server/setup.mjs',
  '/shared/..%2F..%2Fchallenge.json',
]) {
  test(`the page server refuses the traversal ${requestPath} with 404`, async (testContext) => {
    const stack = await startStack(testContext);

    const response = await getRaw(stack.url, requestPath);

    assert.equal(response.status, 404);
  });
}

test('the page server answers 400 for a path with a malformed percent-escape', async (testContext) => {
  const stack = await startStack(testContext);

  const response = await getRaw(stack.url, '/%E0%A4%A');

  assert.equal(response.status, 400);
  assert.equal(response.headers['content-security-policy'], CONTENT_SECURITY_POLICY);
});

test('the page server answers 400 for a progress PUT that is not JSON and stores nothing', async (testContext) => {
  const stack = await startStack(testContext);

  const response = await putProgressTo(stack.url, '{"launched": tru');

  assert.equal(response.status, 400);
  assert.equal(existsSync(stack.paths.progressFile), false);
});

test('the page server answers 413 for a streamed progress body over the cap and stores nothing', async (testContext) => {
  const stack = await startStack(testContext);
  const chunk = new TextEncoder().encode(' '.repeat(4_096));
  const oversizedStream = new ReadableStream({
    start(controller) {
      for (let sent = 0; sent < 5; sent += 1) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  const response = await fetch(`${stack.url}api/progress`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: oversizedStream,
    duplex: 'half',
  });

  assert.equal(response.status, 413);
  assert.equal(existsSync(stack.paths.progressFile), false);
});

test('the page server refuses a symlinked progress file with 422 and leaves its target untouched', async (testContext) => {
  const stack = await startStack(testContext);
  const outside = path.join(await makeTemporaryDirectory(testContext), 'outside.json');
  await writeFile(outside, 'outside secret');
  await symlink(outside, stack.paths.progressFile);
  const progress = createProgress(stack.attemptId);

  const read = await getRaw(stack.url, '/api/progress');
  const write = await putProgressTo(stack.url, JSON.stringify(progress));

  assert.equal(read.status, 422);
  assert.doesNotMatch(read.text, /outside secret/);
  assert.equal(write.status, 422);
  assert.equal(await readFile(outside, 'utf8'), 'outside secret');
});

test("setup keeps the page server in setup's own process group", async (testContext) => {
  const port = await freePort();
  const workspace = await makeWorkspace(testContext, port);

  const setup = await runHook('setup', hookEnvironment(workspace, port), { detached: true });
  testContext.after(() => {
    try {
      process.kill(-setup.pid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
  });

  assert.equal(setup.code, 0, setup.stderr);
  assert.equal(await readProcessColumn('pgid', await readServerPid(workspace)), String(setup.pid));
});

test('setup fails naming the port when it is busy, and leaves the other listener and no pid file', async (testContext) => {
  const port = await freePort();
  await holdPort(testContext, port, 'foreign listener');
  const workspace = await makeWorkspace(testContext, port);

  const setup = await runHook('setup', hookEnvironment(workspace, port));

  assert.notEqual(setup.code, 0);
  assert.match(setup.stderr, new RegExp(`127\\.0\\.0\\.1:${port}`));
  assert.equal(await pageText(port), 'foreign listener');
  assert.equal(existsSync(path.join(workspace, '.glitch', 'server.pid')), false);
});

test('cleanup after a failed setup exits 0 and leaves the other listener answering', async (testContext) => {
  const port = await freePort();
  await holdPort(testContext, port, 'foreign listener');
  const workspace = await makeWorkspace(testContext, port);
  await runHook('setup', hookEnvironment(workspace, port));

  const cleanup = await runHook('cleanup', hookEnvironment(workspace, port));

  assert.equal(cleanup.code, 0, cleanup.stderr);
  assert.equal(await pageText(port), 'foreign listener');
  assert.equal(existsSync(path.join(workspace, '.glitch')), false);
});

test('cleanup after a crash exits 0 and leaves the other listener on the port answering', async (testContext) => {
  const port = await freePort();
  const workspace = await makeWorkspace(testContext, port);
  const setup = await runHook('setup', hookEnvironment(workspace, port));
  assert.equal(setup.code, 0, setup.stderr);
  process.kill(await readServerPid(workspace), 'SIGKILL');
  await waitUntilRefused(port);
  await holdPort(testContext, port, 'foreign listener');

  const cleanup = await runHook('cleanup', hookEnvironment(workspace, port));

  assert.equal(cleanup.code, 0, cleanup.stderr);
  assert.equal(await pageText(port), 'foreign listener');
  assert.equal(existsSync(path.join(workspace, '.glitch')), false);
});

test('cleanup exits 0 when the workspace does not exist', async (testContext) => {
  const port = await freePort();
  const parent = await makeTemporaryDirectory(testContext);

  const cleanup = await runHook('cleanup', hookEnvironment(path.join(parent, 'missing'), port));

  assert.equal(cleanup.code, 0, cleanup.stderr);
});

test('cleanup exits 0 and removes a directory planted at the progress path', async (testContext) => {
  const port = await freePort();
  const workspace = await makeWorkspace(testContext, port);
  const progressPath = path.join(workspace, 'glitch-progress.json');
  await mkdir(progressPath);
  await writeFile(path.join(progressPath, 'inner.txt'), 'planted');

  const cleanup = await runHook('cleanup', hookEnvironment(workspace, port));

  assert.equal(cleanup.code, 0, cleanup.stderr);
  assert.equal(existsSync(progressPath), false);
});

test('cleanup exits 0 and unlinks a symlinked progress file, leaving its target untouched', async (testContext) => {
  const port = await freePort();
  const workspace = await makeWorkspace(testContext, port);
  const outside = path.join(await makeTemporaryDirectory(testContext), 'outside.json');
  await writeFile(outside, 'outside secret');
  const progressPath = path.join(workspace, 'glitch-progress.json');
  await symlink(outside, progressPath);

  const cleanup = await runHook('cleanup', hookEnvironment(workspace, port));

  assert.equal(cleanup.code, 0, cleanup.stderr);
  assert.equal(existsSync(progressPath), false);
  assert.equal(await readFile(outside, 'utf8'), 'outside secret');
});

test('setup refuses a symlinked .glitch directory and leaves the outside directory untouched', async (testContext) => {
  const port = await freePort();
  const workspace = await makeWorkspace(testContext, port);
  const outside = await makeTemporaryDirectory(testContext);
  await writeFile(path.join(outside, 'keep.txt'), 'outside secret');
  await symlink(outside, path.join(workspace, '.glitch'));

  const setup = await runHook('setup', hookEnvironment(workspace, port));

  assert.notEqual(setup.code, 0);
  assert.match(setup.stderr, /^setup: \.glitch is not a directory/);
  assert.deepEqual(await readdir(outside), ['keep.txt']);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside secret');
  assert.equal(await isRefused(port), true);
});

test('setup refuses a symlinked runtime config and leaves its target untouched', async (testContext) => {
  const port = await freePort();
  const workspace = await makeWorkspace(testContext, port);
  const outside = path.join(await makeTemporaryDirectory(testContext), 'outside.json');
  await writeFile(outside, 'outside secret');
  await mkdir(path.join(workspace, '.glitch'));
  await symlink(outside, path.join(workspace, '.glitch', 'runtime-config.json'));

  const setup = await runHook('setup', hookEnvironment(workspace, port));

  assert.notEqual(setup.code, 0);
  assert.match(setup.stderr, /^setup: runtime-config\.json is not a regular file with one link/);
  assert.equal(await readFile(outside, 'utf8'), 'outside secret');
  assert.equal(await isRefused(port), true);
});

test('cleanup after a refused setup exits 0 and unlinks the symlinked .glitch, leaving its target', async (testContext) => {
  const port = await freePort();
  const workspace = await makeWorkspace(testContext, port);
  const outside = await makeTemporaryDirectory(testContext);
  await writeFile(path.join(outside, 'keep.txt'), 'outside secret');
  await symlink(outside, path.join(workspace, '.glitch'));
  await runHook('setup', hookEnvironment(workspace, port));

  const cleanup = await runHook('cleanup', hookEnvironment(workspace, port));

  assert.equal(cleanup.code, 0, cleanup.stderr);
  assert.equal(existsSync(path.join(workspace, '.glitch')), false);
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside secret');
});

test('setup and cleanup run standalone from the current directory with no BOOTHSTRAP_ variables', async (testContext) => {
  const port = await freePort();
  const workspace = await makeWorkspace(testContext, port);
  const env = { PATH: process.env.PATH, GLITCH_PORT: String(port) };

  const setup = await runHook('setup', env, { cwd: workspace });
  const served = await getRaw(`http://127.0.0.1:${port}/`, '/');
  const pid = await readServerPid(workspace);
  const cleanup = await runHook('cleanup', env, { cwd: workspace });

  assert.equal(setup.code, 0, setup.stderr);
  assert.match(setup.stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}/`));
  assert.equal(served.status, 200);
  assert.equal(cleanup.code, 0, cleanup.stderr);
  assert.equal(alive(pid), false);
  assert.equal(await isRefused(port), true);
  assert.equal(existsSync(path.join(workspace, '.glitch')), false);
});

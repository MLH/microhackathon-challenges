// Proves the glitch-invaders package: the three intentional failures trigger
// through gameplay and verify their repairs in play; stack frames match the
// real source lines; the IncidentTracker enforces stage progression; the page
// server serves native .mjs modules under a strict CSP, enforces origin, host,
// size, and path checks, and refuses a planted progress file; the setup and
// cleanup hooks start and stop the server cleanly, including after failures; and
// live Sentry mode turns on only with a token and filled-in settings, reads
// evidence from a local stand-in for the Sentry API without ever exposing the
// token, and falls back to labelled simulated evidence when Sentry fails.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
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
import {
  SHIELD_STACK_FRAMES,
  WEAPON_STACK_FRAMES,
} from '../challenges/glitch-invaders/game/src/diagnostics/evidence-builders.mjs';
import {
  FALLBACK_NOTES,
  LiveEvidenceProvider,
} from '../challenges/glitch-invaders/game/src/diagnostics/live-evidence.mjs';
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
import { SentryReporter } from '../challenges/glitch-invaders/game/src/sentry/reporter.mjs';
import { WeaponConfigError } from '../challenges/glitch-invaders/game/src/weapons/weapons.mjs';
import { runCleanup } from '../challenges/glitch-invaders/server/cleanup.mjs';
import { createEvidenceLookup } from '../challenges/glitch-invaders/server/page-server.mjs';
import { resolveStatePaths } from '../challenges/glitch-invaders/server/paths.mjs';
import { SentryApi } from '../challenges/glitch-invaders/server/sentry-api.mjs';
import { runSetup } from '../challenges/glitch-invaders/server/setup.mjs';
import { BUG_IDS, createProgress, monitorStateLine } from '../challenges/glitch-invaders/shared/progress.mjs';
import { isSentryApiOrigin } from '../challenges/glitch-invaders/shared/runtime-config.mjs';

const runFile = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.join(testDirectory, '..', 'challenges', 'glitch-invaders');
const FRAME_MS = 16;
const SERVER_EXIT_TIMEOUT_MS = 5_000;
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'";
const SENTRY_TOKEN = 'sntrys_stand-in-token-that-must-never-show';
const LIVE_DSN = 'https://publickey@o1.ingest.us.sentry.io/42';
const WEAPON_EVENT_ID = 'a'.repeat(32);
const SHIELD_EVENT_ID = 'b'.repeat(32);
const BOSS_TRACE_ID = 'c'.repeat(32);

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

/** A Sentry API error event as the events endpoint returns it; `overrides` replace fields. */
function sentryEventFactory(overrides = {}) {
  return {
    eventID: WEAPON_EVENT_ID,
    groupID: '7001',
    title: 'WeaponConfigError: Configuration missing for weapon: fanout',
    contexts: {
      weapon_state: { attemptedWeapon: 'fanout', availableWeapons: ['single'], type: 'default' },
    },
    entries: [
      {
        type: 'exception',
        data: {
          values: [
            {
              type: 'WeaponConfigError',
              value: 'Configuration missing for weapon: fanout',
              stacktrace: {
                frames: [
                  { function: 'GameEngine.tryFire', filename: 'game/src/engine/game-engine.mjs', lineNo: 320, inApp: true },
                  { function: 'fireWeapon', filename: 'game/src/weapons/weapons.mjs', lineNo: 46, inApp: true },
                ],
              },
            },
          ],
        },
      },
    ],
    ...overrides,
  };
}

/** A Sentry API issue; `overrides` replace fields. */
function sentryIssueFactory(overrides = {}) {
  return {
    id: '7001',
    shortId: 'GLITCH-INVADERS-1',
    title: 'WeaponConfigError: Configuration missing for weapon: fanout',
    permalink: 'https://mlh.sentry.io/issues/7001/',
    ...overrides,
  };
}

/** The shield event: an exception, its breadcrumb trail, and the shield context. */
function shieldEventFactory() {
  return sentryEventFactory({
    eventID: SHIELD_EVENT_ID,
    groupID: '7002',
    contexts: { shield_state: { shieldActive: true, actualDamage: 3, type: 'default' } },
    entries: [
      {
        type: 'exception',
        data: { values: [{ type: 'GameLogicError', value: 'Shield was active but 3 damage was applied' }] },
      },
      {
        type: 'breadcrumbs',
        data: {
          values: [
            { timestamp: '2026-10-17T12:00:00.000Z', category: 'game.shield', message: 'Shield enabled', level: 'info', data: { shieldActive: 'true' } },
            { timestamp: '2026-10-17T12:00:05.600Z', category: 'game.combat', message: 'Actual damage applied: 3', level: 'warning', data: { actualDamage: '3' } },
            { timestamp: '2026-10-17T12:00:06.800Z', category: 'game.combat', message: 'Ship destroyed: shield failed to protect', level: 'fatal' },
          ],
        },
      },
    ],
  });
}

/** The spans endpoint rows for the boss trace: two sequential loads of 1.2 s and 1.0 s. */
function bossSpanRows() {
  return [
    { 'span.description': 'loadTextures', 'span.op': 'game.resource.load', 'span.duration': 1200, 'precise.start_ts': 1_000 },
    { 'span.description': 'loadSounds', 'span.op': 'game.resource.load', 'span.duration': 1000, 'precise.start_ts': 1_001.2 },
  ];
}

/**
 * Start a local stand-in for the Sentry API that answers the routes the page server calls from
 * `routes` (pathname to body, or a status number), records each request, and closes when the test
 * ends. `outage` makes every route answer 503, and `unindexedRequests` makes that many first
 * requests answer 404, as Sentry does before it has indexed a report. Every refusal echoes the
 * request's Authorization header, so a server that forwarded Sentry's error body would leak it.
 */
function startSentryStandIn(testContext, options = {}) {
  const routes = {
    '/api/0/projects/mlh/glitch-invaders/events/': { data: [] },
    [`/api/0/projects/mlh/glitch-invaders/events/${WEAPON_EVENT_ID}/`]: sentryEventFactory(),
    [`/api/0/projects/mlh/glitch-invaders/events/${SHIELD_EVENT_ID}/`]: shieldEventFactory(),
    '/api/0/organizations/mlh/issues/7001/': sentryIssueFactory(),
    '/api/0/organizations/mlh/issues/7002/': sentryIssueFactory({ shortId: 'GLITCH-INVADERS-2', title: 'GameLogicError: Shield was active' }),
    '/api/0/organizations/mlh/events/': { data: bossSpanRows() },
    ...options.routes,
  };
  const requests = [];

  return new Promise((resolve, reject) => {
    const server = createHttpServer((incoming, response) => {
      const url = new URL(incoming.url ?? '/', 'http://localhost');
      requests.push({ method: incoming.method, url, authorization: incoming.headers.authorization });
      const unindexed = requests.length <= (options.unindexedRequests ?? 0);
      const route = options.outage ? 503 : unindexed ? 404 : (routes[url.pathname] ?? 404);
      if (typeof route === 'number') {
        response.writeHead(route).end(JSON.stringify({ detail: incoming.headers.authorization }));

        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(route));
    });
    testContext.after(
      () =>
        new Promise((done) => {
          server.close(done);
          server.closeAllConnections();
        }),
    );
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests });
    });
  });
}

/** Run `hook` from the package at `packageDir` and resolve with its exit code and output. */
function runPackageHook(packageDir, hook, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(packageDir, hook), [], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

/**
 * Copy the package with `settings` as its `sentry.json`. Resolves with the copy's directory, which
 * {@link startLivePackage} removes once its cleanup hook has run.
 */
async function makePackageWithSettings(settings) {
  const copyRoot = await mkdtemp(path.join(os.tmpdir(), 'glitch-package-'));
  const packageDir = path.join(copyRoot, 'glitch-invaders');
  await cp(packageDirectory, packageDir, { recursive: true });
  await writeFile(path.join(packageDir, 'sentry.json'), `${JSON.stringify(settings)}\n`);

  return packageDir;
}

/**
 * Copy the package with live settings pointing at `apiUrl`, so the shipped hooks run against the
 * stand-in.
 */
function makeLivePackage(apiUrl) {
  return makePackageWithSettings({ dsn: LIVE_DSN, org: 'mlh', project: 'glitch-invaders', apiUrl });
}

/**
 * Run the live package's setup hook in a fresh workspace with `extraEnv`, registering its cleanup
 * hook. Resolves with the server's base URL, the hook's output, and the workspace.
 */
async function startLivePackage(testContext, packageDir, extraEnv) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'glitch-live-'));
  const port = await freePort();
  const env = { ...hookEnvironment(workspace, port), ...extraEnv };
  testContext.after(async () => {
    await runPackageHook(packageDir, 'cleanup', env);
    await rm(workspace, { recursive: true, force: true });
    await rm(path.dirname(packageDir), { recursive: true, force: true });
  });

  const setup = await runPackageHook(packageDir, 'setup', env);
  assert.equal(setup.code, 0, setup.output);

  return { base: `http://127.0.0.1:${port}`, output: setup.output, workspace, packageDir, env };
}

/** Start a live stack: a Sentry stand-in, a live package copy, and its server with the token. */
async function startLiveStack(testContext, standInOptions = {}) {
  const standIn = await startSentryStandIn(testContext, standInOptions);
  const packageDir = await makeLivePackage(standIn.url);
  const stack = await startLivePackage(testContext, packageDir, { SENTRY_AUTH_TOKEN: SENTRY_TOKEN });

  return { ...stack, standIn };
}

/** Ask the page server at `base` for the live evidence of report `id` of `bug`. */
function fetchEvidence(base, bug, id) {
  return fetch(`${base}/api/sentry-evidence?bug=${bug}&id=${id}`);
}

/** A reporter fake for the page's live provider: it records reports and answers with `outcome`. */
function fakeReporter(outcome) {
  const reported = [];

  return {
    reported,
    report: async (encounter) => {
      reported.push(encounter);

      return outcome;
    },
  };
}

/** A fetch fake that answers every request with `response`, recording the URLs asked for. */
function fakeFetch(response) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(String(url));

    return response;
  };

  return { urls, fetchImpl };
}

/** The weapon encounter the engine reports when the fan-out upgrade jams. */
function weaponEncounterFactory() {
  return {
    bug: 'weapon',
    jam: {
      weaponId: 'fanout',
      availableWeapons: ['single'],
      error: new Error('Configuration missing for weapon: fanout'),
    },
  };
}

test('weapon and shield stack trace frames point at the real lines of the calls they name', () => {
  const callAtLine = {
    fireWeapon: 'throw new WeaponConfigError',
    'GameEngine.tryFire': 'fireWeapon(',
    'GameEngine.updatePlayer': 'this.tryFire()',
    'GameEngine.update': 'this.updatePlayer(',
    'GameLoop.frame': 'this.engine.update(',
    resolveShieldHit: 'incomingDamage * SHIELD_BUG_MULTIPLIER',
  };

  const inApp = [...WEAPON_STACK_FRAMES, ...SHIELD_STACK_FRAMES].filter((frame) => frame.inApp);
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

test('the game page shows a hidden save error that the progress store unhides on a failed save', async () => {
  const page = await readFile(path.join(packageDirectory, 'game', 'index.html'), 'utf8');
  const main = await readFile(path.join(packageDirectory, 'game', 'src', 'main.mjs'), 'utf8');

  assert.match(
    page,
    /<p id="save-error"[^>]*\shidden[^>]*>Progress can't be saved; reload the page\.<\/p>/,
  );
  assert.match(main, /new HttpProgressStore\([\s\S]*?showSaveError,?\s*\)/);
  assert.match(main, /getElementById\('save-error'\)[\s\S]*?\.hidden = false/);
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

test('setup unlinks a symlinked pid file, and cleanup stops the server, leaving its target untouched', async (testContext) => {
  const port = await freePort();
  const workspace = await makeWorkspace(testContext, port);
  const outside = path.join(await makeTemporaryDirectory(testContext), 'outside.pid');
  await writeFile(outside, 'outside secret');
  await mkdir(path.join(workspace, '.glitch'));
  await symlink(outside, path.join(workspace, '.glitch', 'server.pid'));
  await runHook('setup', hookEnvironment(workspace, port));

  const cleanup = await runHook('cleanup', hookEnvironment(workspace, port));

  assert.equal(cleanup.code, 0, cleanup.stderr);
  await waitUntilRefused(port);
  assert.equal(await readFile(outside, 'utf8'), 'outside secret');
});

test('setup exits 0 and clears a directory planted at the progress path', async (testContext) => {
  const port = await freePort();
  const workspace = await makeWorkspace(testContext, port);
  const progressPath = path.join(workspace, 'glitch-progress.json');
  await mkdir(progressPath);
  await writeFile(path.join(progressPath, 'inner.txt'), 'planted');

  const setup = await runHook('setup', hookEnvironment(workspace, port));

  assert.equal(setup.code, 0, setup.stderr);
  assert.equal(existsSync(progressPath), false);
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

test('the package names the gemini and sentry vault services and ships live Sentry settings for sentry.io', async () => {
  const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'challenge.json'), 'utf8'));
  const settings = JSON.parse(await readFile(path.join(packageDirectory, 'sentry.json'), 'utf8'));

  assert.deepEqual(manifest.vault_services, ['gemini', 'sentry']);
  assert.match(settings.dsn, /^https:\/\/[0-9a-f]{32}@o\d+\.ingest\.(us\.)?sentry\.io\/\d+$/);
  assert.match(settings.org, /^[a-z0-9-]+$/);
  assert.match(settings.project, /^[a-z0-9-]+$/);
  assert.equal(settings.apiUrl, undefined);
});

test('setup stays in demo mode with SENTRY_AUTH_TOKEN set while sentry.json holds placeholders', async (testContext) => {
  const packageDir = await makePackageWithSettings({
    dsn: '<https://public-key@o0.ingest.us.sentry.io/0>',
    org: '<org-slug>',
    project: '<project-slug>',
  });
  const stack = await startLivePackage(testContext, packageDir, { SENTRY_AUTH_TOKEN: SENTRY_TOKEN });

  const config = await (await fetch(`${stack.base}/runtime-config.json`)).json();
  const page = await getRaw(`${stack.base}/`, '/');
  const evidence = await fetchEvidence(stack.base, 'weapon', WEAPON_EVENT_ID);

  assert.deepEqual(Object.keys(config), ['attemptId']);
  assert.doesNotMatch(stack.output, /live Sentry mode/);
  assert.equal(page.headers['content-security-policy'], CONTENT_SECURITY_POLICY);
  assert.equal(evidence.status, 404);
});

test('setup notes that live mode is off when sentry.json is filled in but SENTRY_AUTH_TOKEN is unset', async (testContext) => {
  const standIn = await startSentryStandIn(testContext);
  const packageDir = await makeLivePackage(standIn.url);

  const stack = await startLivePackage(testContext, packageDir, {});

  const config = await (await fetch(`${stack.base}/runtime-config.json`)).json();
  assert.match(stack.output, /^Glitch Invaders is ready at http:\/\/127\.0\.0\.1:\d+\/\n/);
  assert.match(stack.output, /note: live Sentry mode is off: SENTRY_AUTH_TOKEN is not set/);
  assert.deepEqual(Object.keys(config), ['attemptId']);
  assert.equal(standIn.requests.length, 0);
});

test('setup fails naming sentry.json when a filled-in value is malformed', async (testContext) => {
  const standIn = await startSentryStandIn(testContext);
  const packageDir = await makeLivePackage(standIn.url);
  const settings = { dsn: 'http://publickey@o1.ingest.us.sentry.io/42', org: 'mlh', project: 'glitch-invaders' };
  await writeFile(path.join(packageDir, 'sentry.json'), JSON.stringify(settings));
  const workspace = await makeTemporaryDirectory(testContext);
  testContext.after(() => rm(path.dirname(packageDir), { recursive: true, force: true }));

  const setup = await runPackageHook(packageDir, 'setup', hookEnvironment(workspace, await freePort()));

  assert.equal(setup.code, 1);
  assert.match(setup.output, /setup: sentry\.json: invalid runtime config: sentry\.dsn must be a Sentry DSN/);
});

test('setup takes live Sentry settings from SENTRY_DSN, SENTRY_ORG, SENTRY_PROJECT, and SENTRY_URL over sentry.json', async (testContext) => {
  const standIn = await startSentryStandIn(testContext);
  const packageDir = await makePackageWithSettings({
    dsn: 'https://packagekey@o9.ingest.us.sentry.io/99',
    org: 'package-org',
    project: 'package-project',
  });
  const stack = await startLivePackage(testContext, packageDir, {
    SENTRY_AUTH_TOKEN: SENTRY_TOKEN,
    SENTRY_DSN: LIVE_DSN,
    SENTRY_ORG: 'mlh',
    SENTRY_PROJECT: 'glitch-invaders',
    SENTRY_URL: standIn.url,
  });

  const config = await (await fetch(`${stack.base}/runtime-config.json`)).json();
  const evidence = await fetchEvidence(stack.base, 'weapon', WEAPON_EVENT_ID);

  assert.match(stack.output, /\(live Sentry mode\)/);
  assert.deepEqual(config.sentry, { dsn: LIVE_DSN, org: 'mlh', project: 'glitch-invaders', apiUrl: standIn.url });
  assert.equal(evidence.status, 200);
  assert.equal(standIn.requests[0].url.pathname, `/api/0/projects/mlh/glitch-invaders/events/${WEAPON_EVENT_ID}/`);
});

test('setup fails naming the unset variables when the environment sets only some Sentry settings', async (testContext) => {
  const workspace = await makeTemporaryDirectory(testContext);
  const env = { ...hookEnvironment(workspace, await freePort()), SENTRY_DSN: LIVE_DSN, SENTRY_ORG: '' };
  testContext.after(() => runHook('cleanup', env));

  const setup = await runHook('setup', env);

  assert.equal(setup.code, 1);
  assert.match(
    setup.stderr,
    /setup: Sentry settings in the environment are incomplete: SENTRY_ORG, SENTRY_PROJECT not set/,
  );
});

test('setup fails naming the environment when a Sentry setting there is malformed', async (testContext) => {
  const workspace = await makeTemporaryDirectory(testContext);
  const env = {
    ...hookEnvironment(workspace, await freePort()),
    SENTRY_DSN: LIVE_DSN,
    SENTRY_ORG: 'mlh',
    SENTRY_PROJECT: 'glitch-invaders',
    SENTRY_URL: 'https://sentry.example.com',
  };
  testContext.after(() => runHook('cleanup', env));

  const setup = await runHook('setup', env);

  assert.equal(setup.code, 1);
  assert.match(
    setup.stderr,
    /setup: Sentry settings in the environment: invalid runtime config: sentry\.apiUrl must be https:\/\/sentry\.io or a subdomain/,
  );
});

test('live mode fetches the weapon issue from the Sentry API with the token and returns its stack trace', async (testContext) => {
  const stack = await startLiveStack(testContext);

  const response = await fetchEvidence(stack.base, 'weapon', WEAPON_EVENT_ID);

  assert.equal(response.status, 200);
  const evidence = await response.json();
  assert.equal(evidence.source, 'live');
  assert.equal(evidence.referenceId, 'GLITCH-INVADERS-1');
  assert.deepEqual(evidence.link, { label: 'Open the issue in Sentry', url: 'https://mlh.sentry.io/issues/7001/' });
  const frames = evidence.sections.find((section) => section.kind === 'stacktrace').frames;
  assert.deepEqual(
    frames.map((frame) => `${frame.functionName} ${frame.file}:${frame.line}`),
    ['fireWeapon game/src/weapons/weapons.mjs:46', 'GameEngine.tryFire game/src/engine/game-engine.mjs:320'],
  );
  const context = evidence.sections.find((section) => section.kind === 'context');
  assert.deepEqual(context.entries, { attemptedWeapon: 'fanout', availableWeapons: 'single' });
  assert.deepEqual(
    stack.standIn.requests.map((request) => [request.url.pathname, request.authorization]),
    [
      [`/api/0/projects/mlh/glitch-invaders/events/${WEAPON_EVENT_ID}/`, `Bearer ${SENTRY_TOKEN}`],
      ['/api/0/organizations/mlh/issues/7001/', `Bearer ${SENTRY_TOKEN}`],
    ],
  );
});

test('live mode returns the shield breadcrumbs timed from the last one', async (testContext) => {
  const stack = await startLiveStack(testContext);

  const evidence = await (await fetchEvidence(stack.base, 'shield', SHIELD_EVENT_ID)).json();

  const crumbs = evidence.sections.find((section) => section.kind === 'breadcrumbs').entries;
  assert.deepEqual(
    crumbs.map((crumb) => [crumb.offsetLabel, crumb.level, crumb.message]),
    [
      ['-6.8 s', 'info', 'Shield enabled'],
      ['-1.2 s', 'warning', 'Actual damage applied: 3'],
      ['0.0 s', 'error', 'Ship destroyed: shield failed to protect'],
    ],
  );
  assert.equal(evidence.referenceId, 'GLITCH-INVADERS-2');
});

test('live mode returns the boss trace as a waterfall from the spans Sentry indexed', async (testContext) => {
  const stack = await startLiveStack(testContext);

  const evidence = await (await fetchEvidence(stack.base, 'boss', BOSS_TRACE_ID)).json();

  const waterfall = evidence.sections.find((section) => section.kind === 'waterfall');
  assert.deepEqual(
    waterfall.spans.map((span) => [span.name, span.startMs, span.durationMs]),
    [
      ['loadTextures', 0, 1200],
      ['loadSounds', 1200, 1000],
    ],
  );
  assert.equal(waterfall.totalMs, 2200);
  assert.equal(evidence.link.url, `https://mlh.sentry.io/explore/traces/trace/${BOSS_TRACE_ID}/`);
  const context = evidence.sections.find((section) => section.kind === 'context');
  assert.equal(context.caption, 'Local game state, not from Sentry');
  const query = stack.standIn.requests[0].url.searchParams;
  assert.equal(query.get('dataset'), 'spans');
  assert.equal(query.get('query'), `trace:${BOSS_TRACE_ID} span.op:game.resource.load`);
});

test('live mode lets the page reach the DSN ingest origin and no other', async (testContext) => {
  const stack = await startLiveStack(testContext);

  const page = await getRaw(`${stack.base}/`, '/');

  assert.equal(
    page.headers['content-security-policy'],
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://o1.ingest.us.sentry.io",
  );
});

test('the token never appears in a response, a page asset, the workspace, or hook output', async (testContext) => {
  const stack = await startLiveStack(testContext);
  const outage = await startLiveStack(testContext, { outage: true });

  const gameAssets = (await readdir(path.join(packageDirectory, 'game'), { recursive: true }))
    .filter((file) => path.extname(file) !== '')
    .map((file) => `${stack.base}/${file.split(path.sep).join('/')}`);
  const sharedAssets = (await readdir(path.join(packageDirectory, 'shared'))).map(
    (file) => `${stack.base}/shared/${file}`,
  );
  const bodies = await Promise.all(
    [
      ...gameAssets,
      ...sharedAssets,
      `${stack.base}/runtime-config.json`,
      `${stack.base}/api/progress`,
      `${stack.base}/api/sentry-evidence?bug=weapon&id=${WEAPON_EVENT_ID}`,
      `${stack.base}/api/sentry-evidence?bug=boss&id=not-an-id`,
      `${outage.base}/api/sentry-evidence?bug=shield&id=${SHIELD_EVENT_ID}`,
    ].map(async (url) => {
      const response = await fetch(url);

      return `${JSON.stringify([...response.headers])}${await response.text()}`;
    }),
  );
  const workspaceFiles = await readdir(stack.workspace, { recursive: true, withFileTypes: true });
  const stored = await Promise.all(
    workspaceFiles
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(path.join(entry.parentPath, entry.name), 'utf8')),
  );

  const cleanup = await runPackageHook(stack.packageDir, 'cleanup', stack.env);

  for (const text of [...bodies, ...stored, stack.output, outage.output, cleanup.output]) {
    assert.ok(!text.includes(SENTRY_TOKEN), `the token leaked into: ${text.slice(0, 200)}`);
  }
  assert.match(stack.output, /\(live Sentry mode\)/);
});

test('a Sentry outage answers 502 naming the failed request, without retrying', async (testContext) => {
  const stack = await startLiveStack(testContext, { outage: true });

  const response = await fetchEvidence(stack.base, 'weapon', WEAPON_EVENT_ID);

  assert.equal(response.status, 502);
  assert.equal(
    await response.text(),
    `Sentry answered /api/0/projects/mlh/glitch-invaders/events/${WEAPON_EVENT_ID}/ with 503`,
  );
  assert.equal(stack.standIn.requests.length, 1);
});

test('SentryApi waits while Sentry is still indexing an event, then returns it', async (testContext) => {
  const standIn = await startSentryStandIn(testContext, { unindexedRequests: 2 });
  const waits = [];
  const api = new SentryApi({
    apiUrl: standIn.url,
    org: 'mlh',
    project: 'glitch-invaders',
    token: SENTRY_TOKEN,
    retryDelaysMs: [1_000, 2_000, 3_000],
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
    },
  });

  const event = await api.event(WEAPON_EVENT_ID, new AbortController().signal);

  assert.equal(event.eventID, WEAPON_EVENT_ID);
  assert.deepEqual(waits, [1_000, 2_000]);
  assert.equal(standIn.requests.length, 3);
});

test('SentryApi gives up as unavailable once Sentry never indexes the report', async (testContext) => {
  const standIn = await startSentryStandIn(testContext, { unindexedRequests: 10 });
  const api = new SentryApi({
    apiUrl: standIn.url,
    org: 'mlh',
    project: 'glitch-invaders',
    token: SENTRY_TOKEN,
    retryDelaysMs: [1_000, 2_000],
    sleep: async () => {},
  });

  await assert.rejects(api.traceSpans(BOSS_TRACE_ID, new AbortController().signal), {
    name: 'SentryUnavailableError',
    message: 'Sentry has not indexed the report yet',
  });
  assert.equal(standIn.requests.length, 3);
});

test('the live provider falls back to simulated evidence with a visible note when Sentry fails', async () => {
  const reporter = fakeReporter({ id: WEAPON_EVENT_ID, delivered: true });
  const server = fakeFetch(new Response('Sentry answered with 503', { status: 502 }));
  const provider = new LiveEvidenceProvider({
    reporter,
    simulated: new SimulatedEvidenceProvider(),
    fetchImpl: server.fetchImpl,
  });

  const evidence = await provider.evidenceFor(weaponEncounterFactory());

  assert.equal(evidence.source, 'fallback');
  assert.equal(evidence.note, FALLBACK_NOTES.unavailable);
  assert.ok(evidence.sections.some((section) => section.kind === 'stacktrace'));
  assert.deepEqual(server.urls, [`/api/sentry-evidence?bug=weapon&id=${WEAPON_EVENT_ID}`]);
});

test('the live provider falls back without asking the server when Sentry refused the report', async () => {
  const server = fakeFetch(new Response('{}'));
  const provider = new LiveEvidenceProvider({
    reporter: fakeReporter({ id: WEAPON_EVENT_ID, delivered: false }),
    simulated: new SimulatedEvidenceProvider(),
    fetchImpl: server.fetchImpl,
  });

  const evidence = await provider.evidenceFor(weaponEncounterFactory());

  assert.equal(evidence.source, 'fallback');
  assert.equal(evidence.note, FALLBACK_NOTES.unsent);
  assert.deepEqual(server.urls, []);
});

test('SentryReporter posts one tagged error event per bug to the DSN envelope endpoint', async () => {
  const ingest = [];
  const reporter = new SentryReporter({ dsn: LIVE_DSN }, 'attempt-1', async (url, init) => {
    ingest.push({ url, body: init.body });

    return new Response('{}');
  });
  reporter.add({ category: 'game.weapon', message: 'Firing weapon: fanout' });

  const first = await reporter.report(weaponEncounterFactory());
  const repeat = await reporter.report(weaponEncounterFactory());

  assert.deepEqual(repeat, first);
  assert.equal(first.delivered, true);
  assert.equal(ingest.length, 1);
  assert.match(ingest[0].url, /^https:\/\/o1\.ingest\.us\.sentry\.io\/api\/42\/envelope\/\?.*sentry_key=publickey/);
  const [header, item, payload] = ingest[0].body.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(header.event_id, first.id);
  assert.equal(item.type, 'event');
  assert.deepEqual(payload.tags, { run_id: 'attempt-1', bug: 'weapon' });
  assert.equal(payload.exception.values[0].stacktrace.frames.at(-1).function, 'fireWeapon');
  assert.equal(payload.breadcrumbs[0].message, 'Firing weapon: fanout');
});

test('SentryReporter sends the boss stall as a boss-spawn transaction with one span per load', async () => {
  const ingest = [];
  const reporter = new SentryReporter({ dsn: LIVE_DSN }, 'attempt-1', async (_url, init) => {
    ingest.push(init.body);

    return new Response('{}');
  });
  const stall = {
    totalMs: 2_200,
    spans: [
      { name: 'loadTextures', operation: 'game.resource.load', startMs: 0, durationMs: 1_200 },
      { name: 'loadSounds', operation: 'game.resource.load', startMs: 1_200, durationMs: 1_000 },
    ],
  };

  const outcome = await reporter.report({ bug: 'boss', stall });

  const [, item, payload] = ingest[0].trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(item.type, 'transaction');
  assert.equal(payload.transaction, 'boss-spawn');
  assert.equal(payload.contexts.trace.trace_id, outcome.id);
  assert.deepEqual(
    payload.spans.map((span) => [span.description, span.op, Math.round((span.timestamp - span.start_timestamp) * 1_000)]),
    [
      ['loadTextures', 'game.resource.load', 1200],
      ['loadSounds', 'game.resource.load', 1000],
    ],
  );
});

for (const [apiUrl, allowed] of [
  ['https://sentry.io', true],
  ['https://de.sentry.io', true],
  ['http://127.0.0.1:8123', true],
  ['http://localhost:8123', true],
  ['https://sentry.io.evil.example', false],
  ['https://evilsentry.io', false],
  ['https://sentry.io:8443', false],
  ['http://sentry.io', false],
  ['https://sentry.io/api', false],
  ['http://10.0.0.5:8123', false],
]) {
  test(`the token may go to ${apiUrl}: ${allowed}`, () => {
    const verdict = isSentryApiOrigin(apiUrl);

    assert.equal(verdict, allowed);
  });
}

test('SentryApi stops waiting and fails as unavailable once its deadline passes', async (testContext) => {
  const standIn = await startSentryStandIn(testContext, { unindexedRequests: 10 });
  const deadline = new AbortController();
  const api = new SentryApi({
    apiUrl: standIn.url,
    org: 'mlh',
    project: 'glitch-invaders',
    token: SENTRY_TOKEN,
    retryDelaysMs: [1_000, 2_000, 3_000],
    sleep: async () => deadline.abort(),
  });

  await assert.rejects(api.event(WEAPON_EVENT_ID, deadline.signal), {
    name: 'SentryUnavailableError',
    message: 'Sentry took too long to return the report',
  });
  assert.equal(standIn.requests.length, 1);
});

test('live mode refuses a cross-site evidence request without calling Sentry', async (testContext) => {
  const stack = await startLiveStack(testContext);

  const crossSite = await getRaw(`${stack.base}/`, `/api/sentry-evidence?bug=weapon&id=${WEAPON_EVENT_ID}`, {
    'sec-fetch-site': 'cross-site',
  });
  const otherOrigin = await getRaw(`${stack.base}/`, `/api/sentry-evidence?bug=weapon&id=${WEAPON_EVENT_ID}`, {
    origin: 'https://evil.example',
  });

  assert.equal(crossSite.status, 403);
  assert.equal(otherOrigin.status, 403);
  assert.equal(stack.standIn.requests.length, 0);
});

test('the evidence lookup shares one Sentry lookup among concurrent requests for a report', async () => {
  const calls = [];
  let finish;
  const lookup = createEvidenceLookup((bug, id, signal) => {
    calls.push({ bug, id, signal });

    return new Promise((resolve) => {
      finish = resolve;
    });
  });

  const first = lookup('weapon', WEAPON_EVENT_ID);
  const second = lookup('weapon', WEAPON_EVENT_ID);
  const other = lookup('shield', SHIELD_EVENT_ID);
  finish({ source: 'live' });

  assert.equal(second, first);
  assert.notEqual(other, first);
  assert.deepEqual(
    calls.map((call) => [call.bug, call.id, call.signal instanceof AbortSignal]),
    [
      ['weapon', WEAPON_EVENT_ID, true],
      ['shield', SHIELD_EVENT_ID, true],
    ],
  );
});

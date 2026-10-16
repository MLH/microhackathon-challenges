// Proves the glitch-invaders package: the three intentional failures trigger
// through gameplay and verify their repairs in play; stack frames match the
// real source lines; the IncidentTracker enforces stage progression; the
// zero-dependency SentryReporter builds valid event and span v2 envelopes; the
// page server serves native .mjs modules, enforces origin/host/size checks on
// progress writes, and starts and stops cleanly through setup and cleanup.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
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
import { BreadcrumbRecorder } from '../challenges/glitch-invaders/game/src/diagnostics/breadcrumbs.mjs';
import { WEAPON_STACK_FRAMES } from '../challenges/glitch-invaders/game/src/diagnostics/evidence-builders.mjs';
import { LiveEvidenceProvider } from '../challenges/glitch-invaders/game/src/diagnostics/live-evidence.mjs';
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
import { parseDsn, SentryReporter } from '../challenges/glitch-invaders/game/src/sentry/sentry-reporter.mjs';
import { WeaponConfigError } from '../challenges/glitch-invaders/game/src/weapons/weapons.mjs';
import { runCleanup } from '../challenges/glitch-invaders/server/cleanup.mjs';
import { resolveStatePaths } from '../challenges/glitch-invaders/server/paths.mjs';
import { runSetup } from '../challenges/glitch-invaders/server/setup.mjs';
import { BUG_IDS, createProgress, monitorStateLine } from '../challenges/glitch-invaders/shared/progress.mjs';

const runFile = promisify(execFile);
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.join(testDirectory, '..', 'challenges', 'glitch-invaders');
const FRAME_MS = 16;

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
  const progress = createProgress('test-attempt', 'demo');
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

/** The environment of a station that provides no live Sentry settings. */
function demoEnvironment() {
  return {
    PATH: process.env.PATH,
    GLITCH_LIVE_CONFIG: path.join(os.tmpdir(), 'glitch-test-no-live-config.json'),
  };
}

/** Run setup for a new attempt in a fresh temporary workspace and register cleanup on `testContext`. */
async function startStack(testContext, extraEnv = {}) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'glitch-ws-'));
  const port = await freePort();
  const env = {
    ...demoEnvironment(),
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

/** The status of `/healthz` when the request claims to be for `host`. */
function statusWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const probe = request(`${url}healthz`, { headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    probe.once('error', reject);
    probe.end();
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
  const tracker = new IncidentTracker(createProgress('test-attempt', 'demo'));
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

test('SimulatedEvidenceProvider and LiveEvidenceProvider build structured evidence and links', async () => {
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
  assert.equal(simulated.link, null);
  assert.ok(simulated.sections.some((section) => section.kind === 'stacktrace'));

  const live = new LiveEvidenceProvider({
    reporter: {
      add: () => undefined,
      traceBossSpawn: async (work) => ({
        result: await work((_name, _op, load) => load()),
        traceId: null,
      }),
      report: async () => ({ referenceId: 'evt1', delivery: 'confirmed' }),
    },
    settings: {
      dsn: 'https://key@o1.ingest.sentry.io/1',
      org: 'acme',
      project: 'booth',
      environment: 'booth',
    },
    attemptId: 'attempt-1',
    recorder: new BreadcrumbRecorder(() => 0),
    clock: () => 0,
  });
  const liveEvidence = await live.evidenceFor(weaponEncounter);
  assert.equal(liveEvidence.source, 'live');
  assert.ok(liveEvidence.link?.url.includes('https://acme.sentry.io/issues/'));
});

test('SentryReporter prewarms the boss-spawn v2 span envelope and sends one event envelope per bug', async () => {
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url, body: options.body });

    return { ok: true };
  };
  const settings = {
    dsn: 'https://publickey@o42.ingest.us.sentry.io/99',
    org: 'acme',
    project: 'booth',
    environment: 'booth',
  };
  const parsed = parseDsn(settings.dsn);
  assert.equal(parsed.publicKey, 'publickey');
  assert.equal(parsed.projectId, '99');
  assert.equal(parsed.orgId, '42');

  const reporter = new SentryReporter(
    settings,
    {
      attemptId: 'attempt-1',
      stationId: 'station-1',
      sessionId: null,
      release: 'glitch-invaders@1.0.0',
    },
    fakeFetch,
  );

  assert.equal(requests.length, 1);
  const [, spanHeaderLine, spanPayloadLine] = requests[0].body.trim().split('\n');
  assert.equal(JSON.parse(spanHeaderLine).type, 'span');
  assert.equal(JSON.parse(spanPayloadLine).items.length, 5);

  const traced = await reporter.traceBossSpawn(async () => 'done');
  assert.match(traced.traceId, /^[0-9a-f]{32}$/);
  assert.equal(traced.result, 'done');

  reporter.add({ category: 'game.shield', message: 'Shield enabled', data: { shieldActive: 'true' } });
  const jam = {
    bug: 'weapon',
    jam: {
      weaponId: 'fanout',
      availableWeapons: ['single'],
      error: new Error('Configuration missing for weapon: fanout'),
    },
  };
  const first = await reporter.report(jam);
  const second = await reporter.report(jam);

  assert.equal(requests.length, 2);
  assert.deepEqual(second, first);
  assert.equal(first.delivery, 'confirmed');
  const [, eventHeaderLine, eventPayloadLine] = requests[1].body.trim().split('\n');
  assert.equal(JSON.parse(eventHeaderLine).type, 'event');
  assert.equal(JSON.parse(eventPayloadLine).exception.values[0].type, 'WeaponConfigError');
});

test('the page server serves native .mjs modules, stores progress, and refuses cross-origin or invalid writes', async (testContext) => {
  const stack = await startStack(testContext);
  const base = stack.url.replace(/\/$/, '');
  const putProgress = (body, headers = {}) =>
    fetch(`${base}/api/progress`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });

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
  assert.equal(config.mode, 'demo');
  assert.equal(config.sentry, null);
  assert.equal(config.attemptId, stack.attemptId);

  const progress = createProgress(stack.attemptId, 'demo');
  progress.launched = true;
  assert.equal((await putProgress(JSON.stringify(progress))).status, 204);

  const stored = await (await fetch(`${base}/api/progress`)).json();
  assert.equal(stored.launched, true);
  assert.equal(JSON.parse(await readFile(stack.paths.progressFile, 'utf8')).launched, true);

  const other = createProgress('another-attempt', 'demo');
  assert.equal((await putProgress(JSON.stringify(other))).status, 409);
  assert.equal((await putProgress('{"version":1}')).status, 400);
  assert.equal((await putProgress('not json')).status, 400);
  assert.equal((await putProgress('{}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await putProgress('x'.repeat(20_000))).status, 413);
  assert.equal(
    (await putProgress(JSON.stringify(progress), { origin: 'https://evil.example' })).status,
    403,
  );
  assert.equal(await statusWithHost(stack.url, 'evil.example'), 403);
  assert.equal((await fetch(`${base}/..%2F..%2Fchallenge.json`)).status, 404);

  assert.equal((await fetch(`${base}/api/progress`, { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(`${base}/api/progress`)).status, 204);
});

test('the shipped setup and cleanup hooks start and stop the server and clean up workspace state', async (testContext) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'glitch-hooks-'));
  const port = await freePort();
  const env = {
    ...demoEnvironment(),
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

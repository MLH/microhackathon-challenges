// Proves the launch-control package against local stand-ins for LaunchDarkly
// and Gemini, with no network and no credentials: switch_travel_agent sends
// the right semantic patch for this session's key only and refuses skips;
// setup resets a leftover target and cleanup is idempotent and safe after a
// crash; the config card's state and the booker-state line update after a
// switch with no reload; the booker's tools read only the fake inventory and
// book_trip writes only inside the workspace; no credential appears in any
// response, page asset, file, or log; and demo mode runs the full ladder from
// ladder.json.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkSwitch, SwitchRefusedError } from '../challenges/launch-control/mcp/switch.mjs';
import { loadLadder, rungByNumber } from '../challenges/launch-control/server/ladder.mjs';
import { stateLine } from '../challenges/launch-control/server/session.mjs';
import { decideMode, readLoopbackOrigin } from '../challenges/launch-control/server/settings.mjs';
import { LaunchDarklyStandIn } from '../challenges/launch-control/server/stand-in.mjs';
import { loadInventory, TravelDesk } from '../challenges/launch-control/server/travel-desk.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.join(testDirectory, '..', 'challenges', 'launch-control');
const ladder = loadLadder(packageDirectory);
const installTimeoutMilliseconds = 300_000;

/** Options for a test that may pay for the shared install. */
const installedPackageTest = { timeout: installTimeoutMilliseconds + 120_000 };

const SDK_KEY = 'sdk-stand-in-key-that-must-never-show';
const API_TOKEN = 'api-stand-in-token-that-must-never-show';
const GEMINI_KEY = 'gemini-stand-in-key-that-must-never-show';
const SECRETS = [SDK_KEY, API_TOKEN, GEMINI_KEY];
const TRIP = 'Round trip to Lisbon, Mar 12–16, flight + hotel near the water, under $900 total.';
const LIVE_SETTINGS = {
  LAUNCHDARKLY_PROJECT_KEY: 'mlh',
  LAUNCHDARKLY_ENVIRONMENT_KEY: 'booth',
  LAUNCHDARKLY_AI_CONFIG_KEY: 'travel-booker',
};

let installedPackage;
let installRoot;
after(() => installRoot && rm(installRoot, { recursive: true, force: true }));

/** Run an executable and resolve with its exit code and output. */
function runExecutable(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 60_000, ...options }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr });
    });
  });
}

/**
 * Copy the package without its node_modules and run its install hook, once per test run.
 * Resolves with the copy's directory; throws with install's stderr when it fails.
 */
function installPackageOnce() {
  installedPackage ??= (async () => {
    installRoot = await mkdtemp(path.join(os.tmpdir(), 'launch-control-test-'));
    const copy = path.join(installRoot, 'launch-control');
    await cp(packageDirectory, copy, {
      recursive: true,
      filter: (source) => path.basename(source) !== 'node_modules' && !source.endsWith('.tmp.mjs'),
    });
    const installed = await runExecutable(path.join(copy, 'install'), [], { timeout: installTimeoutMilliseconds });
    if (installed.code !== 0) {
      throw new Error(`install failed: ${installed.stderr}`);
    }

    return copy;
  })();

  return installedPackage;
}

/** A free loopback port. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Listen on a free loopback port and resolve with the server's origin. */
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

/** A temporary workspace that the test removes when it ends. */
async function makeWorkspace(testContext) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'launch-control-workspace-'));
  testContext.after(() => rm(workspace, { recursive: true, force: true }));

  return workspace;
}

/**
 * Start a LaunchDarkly stand-in in this process, playing LaunchDarkly for live mode, so the test
 * can see every request and seed targets.
 */
async function startLaunchDarkly(testContext) {
  const standIn = new LaunchDarklyStandIn({
    ladder,
    projectKey: LIVE_SETTINGS.LAUNCHDARKLY_PROJECT_KEY,
    environmentKey: LIVE_SETTINGS.LAUNCHDARKLY_ENVIRONMENT_KEY,
    configKey: LIVE_SETTINGS.LAUNCHDARKLY_AI_CONFIG_KEY,
  });
  const server = createServer((request, response) => {
    if (!standIn.handle(request, response, new URL(request.url, 'http://127.0.0.1').pathname)) {
      response.writeHead(404);
      response.end();
    }
  });
  const origin = await listen(server);
  testContext.after(() => {
    standIn.close();
    server.closeAllConnections();
    server.close();
  });

  return { origin, standIn };
}

/** The variation index of `key` in the stand-in, for seeding targets. */
function variationIndex(standIn, key) {
  return standIn.variations.findIndex((variation) => variation.key === key);
}

/** The count of model turns since the last participant message in a Gemini request. */
function turnsSinceParticipant(contents) {
  const lastText = contents.findLastIndex((content) => content.role === 'user' && content.parts.some((part) => part.text !== undefined));

  return contents.slice(lastText + 1).filter((content) => content.role === 'model').length;
}

/** The scripted tool calls a tooled booker makes for the suggested trip, then its answer. */
const TOOLED_SCRIPT = [
  { functionCall: { name: 'search_flights', args: { origin: 'JFK', destination: 'LIS', date: '2027-03-12' } } },
  { functionCall: { name: 'search_flights', args: { origin: 'LIS', destination: 'JFK', date: '2027-03-16' } } },
  { functionCall: { name: 'search_hotels', args: { city: 'Lisbon', check_in: '2027-03-12', check_out: '2027-03-16' } } },
  {
    functionCall: {
      name: 'book_trip',
      args: { outbound_flight_id: 'NV310', return_flight_id: 'NV311', hotel_id: 'LIS-ALFAMA', check_in: '2027-03-12', check_out: '2027-03-16' },
    },
  },
  { text: 'Booked: NV310, NV311, and Alfama Riverside Guesthouse, $818.' },
];

/**
 * Start a Gemini stand-in. A request with no tools gets a plain answer; one with tools books the
 * suggested trip through the script above. It records every request.
 */
async function startGemini(testContext) {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const model = decodeURIComponent(request.url.match(/models\/([^:]+):generateContent/)[1]);
      const toolNames = (body.tools?.[0]?.functionDeclarations ?? []).map((tool) => tool.name);
      requests.push({ model, apiKey: request.headers['x-goog-api-key'], system: body.systemInstruction.parts[0].text, toolNames });
      const part = toolNames.length === 0 ? { text: `I am ${model} and cannot book anything.` } : TOOLED_SCRIPT[turnsSinceParticipant(body.contents)];
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [part] } }] }));
    });
  });
  const origin = await listen(server);
  testContext.after(() => server.close());

  return { origin, requests };
}

/**
 * The hook environment for an attempt: the Gemini stand-in, a free page port, and the session.
 * `live` adds both LaunchDarkly keys, the settings, and the LaunchDarkly stand-in's origin.
 */
async function attemptEnvironment({ workspace, gemini, launchDarkly, sessionId = 'session-under-test' }) {
  return {
    PATH: process.env.PATH,
    HOME: workspace,
    BOOTHSTRAP_WORKSPACE: workspace,
    BOOTHSTRAP_SESSION_ID: sessionId,
    GEMINI_API_KEY: GEMINI_KEY,
    LAUNCH_CONTROL_GEMINI_ORIGIN: gemini.origin,
    LAUNCH_CONTROL_PORT: String(await freePort()),
    ...(launchDarkly === undefined
      ? {}
      : {
          ...LIVE_SETTINGS,
          LAUNCHDARKLY_SDK_API_KEY: SDK_KEY,
          LAUNCHDARKLY_API_AUTH_TOKEN: API_TOKEN,
          LAUNCH_CONTROL_LAUNCHDARKLY_ORIGIN: launchDarkly.origin,
        }),
  };
}

/** Run a hook of the installed package. */
async function runHook(name, env) {
  return runExecutable(path.join(await installPackageOnce(), name), [], { env, cwd: env.BOOTHSTRAP_WORKSPACE });
}

/** Run setup, failing the test on a non-zero exit, and run cleanup when the test ends. */
async function setUpAttempt(testContext, env) {
  const setup = await runHook('setup', env);
  testContext.after(() => runHook('cleanup', env));
  assert.equal(setup.code, 0, setup.stderr);

  return setup;
}

/** The page origin for an attempt's environment. */
function pageOrigin(env) {
  return `http://127.0.0.1:${env.LAUNCH_CONTROL_PORT}`;
}

/** Fetch a page path as text, with its response. */
async function fetchText(env, pathname, init) {
  const response = await fetch(`${pageOrigin(env)}${pathname}`, init);

  return { response, text: await response.text() };
}

/** The page server's live state. */
async function pageState(env) {
  return JSON.parse((await fetchText(env, '/api/state')).text);
}

/** Send the booker a chat message from the page, and resolve with the server's answer. */
async function sendChat(env, message = TRIP) {
  const { response, text } = await fetchText(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: pageOrigin(env) },
    body: JSON.stringify({ message }),
  });
  assert.equal(response.status, 200, text);

  return { body: JSON.parse(text), text };
}

/**
 * Call `switch_travel_agent` through the package's MCP server over stdio, as pi-mcp-adapter does.
 * Resolves with the tool result's text, whether it is an error, and the server's raw output.
 */
async function callSwitch(env, rung, cwd = env.BOOTHSTRAP_WORKSPACE) {
  const server = spawn(process.execPath, [path.join(await installPackageOnce(), 'mcp', 'server.mjs')], {
    env,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  server.stderr.on('data', (chunk) => {
    errors += chunk;
  });
  const answer = new Promise((resolve) => {
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const reply = output
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line))
        .find((message) => message.id === 2);
      if (reply !== undefined) {
        resolve(reply);
      }
    });
  });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'switch_travel_agent', arguments: { rung } } })}\n`);
  const reply = await answer;
  server.kill();

  return { text: reply.result.content[0].text, isError: reply.result.isError === true, output: output + errors };
}

/**
 * Play the whole ladder as a participant and the guide would: send the trip on v1, then switch up
 * one rung and send it again, to v4. Resolves with every state line seen and each rung's config.
 */
async function playLadder(env) {
  const lines = [(await pageState(env)).stateLine];
  const configs = [];
  for (const rung of ladder.rungs) {
    if (rung.rung > 1) {
      const switched = await callSwitch(env, rung.rung);
      assert.equal(switched.isError, false, switched.text);
      lines.push((await pageState(env)).stateLine);
    }
    const { body } = await sendChat(env);
    configs.push(body.config);
    lines.push(body.stateLine);
  }

  return { lines, configs };
}

/** The PATCH requests the LaunchDarkly stand-in received. */
function patches(standIn) {
  return standIn.requests.filter((request) => request.method === 'PATCH');
}

test('checkSwitch allows only the next rung or the rollback to v1, and names the next rung', () => {
  const cases = [
    { current: 1, requested: 2, allowed: true },
    { current: 3, requested: 4, allowed: true },
    { current: 4, requested: 1, allowed: true },
    { current: 2, requested: 1, allowed: true },
    { current: 1, requested: 3, refusal: /The next rung is 2/ },
    { current: 2, requested: 4, refusal: /The next rung is 3/ },
    { current: 3, requested: 2, refusal: /not next/ },
    { current: 2, requested: 2, refusal: /already on v2/ },
    { current: 4, requested: 5, refusal: /whole number from 1 to 4.*rollback/ },
    { current: 1, requested: 1.5, refusal: /whole number/ },
  ];

  for (const { current, requested, allowed, refusal } of cases) {
    if (allowed) {
      assert.equal(checkSwitch(ladder, current, requested).rung, requested);
    } else {
      assert.throws(() => checkSwitch(ladder, current, requested), (error) => error instanceof SwitchRefusedError && refusal.test(error.message));
    }
  }
});

test('the booker-state line spells out the rung, the rungs tried, the booking, and the mode', () => {
  const cases = [
    [{ rung: 1, tried: [], booked: false, mode: 'demo' }, 'booker-state v1 rung=1 tried=none booked=no mode=demo'],
    [{ rung: 4, tried: [1, 2, 3, 4], booked: true, mode: 'live' }, 'booker-state v1 rung=4 tried=1,2,3,4 booked=yes mode=live'],
    [{ rung: null, tried: [1], booked: false, mode: 'live' }, 'booker-state v1 rung=none tried=1 booked=no mode=live'],
  ];

  for (const [state, expected] of cases) {
    assert.equal(stateLine(state), expected);
  }
});

test('live mode needs both LaunchDarkly keys and filled-in settings; anything less is demo mode', async () => {
  const keys = { LAUNCHDARKLY_SDK_API_KEY: SDK_KEY, LAUNCHDARKLY_API_AUTH_TOKEN: API_TOKEN };
  const cases = [
    [{}, 'demo', null],
    [{ ...keys }, 'demo', null],
    [{ ...LIVE_SETTINGS }, 'demo', /LAUNCHDARKLY_SDK_API_KEY and LAUNCHDARKLY_API_AUTH_TOKEN not set/],
    [{ ...LIVE_SETTINGS, LAUNCHDARKLY_SDK_API_KEY: SDK_KEY }, 'demo', /LAUNCHDARKLY_API_AUTH_TOKEN not set/],
    [{ ...LIVE_SETTINGS, ...keys }, 'live', null],
  ];

  for (const [env, mode, note] of cases) {
    const decision = await decideMode(env, packageDirectory);

    assert.equal(decision.mode, mode, JSON.stringify(env));
    if (note === null) {
      assert.equal(decision.note, null);
    } else {
      assert.match(decision.note, note);
    }
  }
});

test('the LaunchDarkly and Gemini origin overrides accept only plain loopback origins', () => {
  assert.equal(readLoopbackOrigin({ X: 'http://127.0.0.1:9000' }, 'X'), 'http://127.0.0.1:9000');
  assert.equal(readLoopbackOrigin({}, 'X'), undefined);
  for (const value of ['https://127.0.0.1:9000', 'http://evil.example', 'http://127.0.0.1:9000/path', 'http://127.0.0.1.evil.example']) {
    assert.throws(() => readLoopbackOrigin({ X: value }, 'X'), /X must be an http:\/\/127.0.0.1/);
  }
});

test('the travel desk searches only the bundled inventory and answers errors the model can act on', async (testContext) => {
  const workspace = await makeWorkspace(testContext);
  const desk = new TravelDesk({ inventory: loadInventory(packageDirectory), itineraryFile: path.join(workspace, 'itinerary.json') });

  const flights = await desk.run('search_flights', { origin: 'jfk', destination: 'LIS', date: '2031-03-12' });
  const hotels = await desk.run('search_hotels', { city: 'lisbon', check_in: '2031-03-12', check_out: '2031-03-16' });
  const noFlights = await desk.run('search_flights', { origin: 'JFK', destination: 'LIS', date: '2031-07-01' });
  const badDate = await desk.run('search_flights', { origin: 'JFK', destination: 'LIS', date: 'March 12' });
  const unknown = await desk.run('delete_everything', {});

  assert.deepEqual(flights.flights.map((flight) => flight.id), ['AT112', 'SK240', 'NV310']);
  assert.ok(flights.flights.every((flight) => flight.date === '2031-03-12'));
  assert.equal(hotels.hotels.length, 5);
  assert.deepEqual(noFlights.flights, []);
  assert.match(badDate.error, /YYYY-MM-DD/);
  assert.match(unknown.error, /no tool named delete_everything/);
});

test('book_trip writes only the itinerary inside the workspace, and refuses pieces that do not fit', async (testContext) => {
  const workspace = await makeWorkspace(testContext);
  const desk = new TravelDesk({ inventory: loadInventory(packageDirectory), itineraryFile: path.join(workspace, 'itinerary.json') });
  const mismatched = await desk.run('book_trip', { outbound_flight_id: 'NV308', return_flight_id: 'NV311', hotel_id: 'LIS-ALFAMA', check_in: '2027-03-12', check_out: '2027-03-16' });
  const unknown = await desk.run('book_trip', { outbound_flight_id: 'XX1', return_flight_id: 'NV311', hotel_id: 'LIS-ALFAMA', check_in: '2027-03-12', check_out: '2027-03-16' });

  const booking = await desk.run('book_trip', { outbound_flight_id: 'NV310', return_flight_id: 'NV311', hotel_id: 'LIS-ALFAMA', check_in: '2027-03-12', check_out: '2027-03-16' });

  assert.match(mismatched.error, /must leave on check_in/);
  assert.match(unknown.error, /Unknown flight or hotel id/);
  assert.equal(booking.total_usd, 818);
  assert.equal(booking.nights, 4);
  assert.deepEqual(await readdir(workspace), ['itinerary.json']);
  assert.equal(JSON.parse(await readFile(path.join(workspace, 'itinerary.json'), 'utf8')).confirmation, booking.confirmation);
});

test('demo mode runs the full ladder from ladder.json, and the monitor line counts only rungs the booker answered on', installedPackageTest, async (testContext) => {
  const workspace = await makeWorkspace(testContext);
  const gemini = await startGemini(testContext);
  const env = await attemptEnvironment({ workspace, gemini });
  const setup = await setUpAttempt(testContext, env);

  const { lines, configs } = await playLadder(env);

  assert.match(setup.stdout, /\(demo mode\)/);
  assert.deepEqual(lines, [
    'booker-state v1 rung=1 tried=none booked=no mode=demo',
    'booker-state v1 rung=1 tried=1 booked=no mode=demo',
    'booker-state v1 rung=2 tried=1 booked=no mode=demo',
    'booker-state v1 rung=2 tried=1,2 booked=no mode=demo',
    'booker-state v1 rung=3 tried=1,2 booked=no mode=demo',
    'booker-state v1 rung=3 tried=1,2,3 booked=no mode=demo',
    'booker-state v1 rung=4 tried=1,2,3 booked=no mode=demo',
    'booker-state v1 rung=4 tried=1,2,3,4 booked=yes mode=demo',
  ]);
  assert.deepEqual(
    configs.map(({ variationKey, model, tools }) => ({ variationKey, model, tools })),
    ladder.rungs.map((rung) => ({ variationKey: rung.key, model: rung.model, tools: rung.tools })),
  );
  assert.deepEqual(
    [...new Set(gemini.requests.map((request) => `${request.model} ${request.toolNames.join(',')}`))],
    [...new Set(ladder.rungs.map((rung) => `${rung.model} ${rung.tools.join(',')}`))],
  );
  assert.ok(gemini.requests.every((request) => ladder.rungs.some((rung) => rung.instructions === request.system)));
});

test('the config card state and the booker-state line change after a switch while the page keeps running', installedPackageTest, async (testContext) => {
  const workspace = await makeWorkspace(testContext);
  const gemini = await startGemini(testContext);
  const env = await attemptEnvironment({ workspace, gemini });
  await setUpAttempt(testContext, env);
  const before = await pageState(env);

  const switched = await callSwitch(env, 2);

  const afterSwitch = await pageState(env);
  const page = await fetchText(env, '/');
  assert.equal(switched.isError, false, switched.text);
  assert.match(switched.text, /config card on the page shows it now/);
  assert.match(page.text, /<p id="boothstrap-state" class="visually-hidden"><\/p>/);
  assert.equal(before.config.name, 'v1 · bare');
  assert.deepEqual(
    { name: afterSwitch.config.name, model: afterSwitch.config.model, tools: afterSwitch.config.tools },
    { name: 'v2 · prompted', model: rungByNumber(ladder, 2).model, tools: [] },
  );
  assert.match(afterSwitch.config.promptExcerpt, /^You are the booking agent at Launch Control Travel Desk/);
  assert.equal(afterSwitch.stateLine, 'booker-state v1 rung=2 tried=none booked=no mode=demo');
});

test('switch_travel_agent sends one semantic patch for this session key only, and refuses a skip without patching', installedPackageTest, async (testContext) => {
  const workspace = await makeWorkspace(testContext);
  const gemini = await startGemini(testContext);
  const launchDarkly = await startLaunchDarkly(testContext);
  const env = await attemptEnvironment({ workspace, gemini, launchDarkly });
  launchDarkly.standIn.targets.set('someone-else', variationIndex(launchDarkly.standIn, 'tooled'));
  await setUpAttempt(testContext, env);
  const patchesAfterSetup = patches(launchDarkly.standIn).length;

  const skip = await callSwitch(env, 3);
  const patchesAfterSkip = patches(launchDarkly.standIn).length;
  const next = await callSwitch(env, 2);

  const sent = patches(launchDarkly.standIn).slice(patchesAfterSkip);
  const promptedId = launchDarkly.standIn.variations[variationIndex(launchDarkly.standIn, 'prompted')]._id;
  assert.equal(skip.isError, true);
  assert.match(skip.text, /The next rung is 2/);
  assert.equal(patchesAfterSkip, patchesAfterSetup);
  assert.equal(next.isError, false, next.text);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].authorization, API_TOKEN);
  assert.match(sent[0].contentType, /domain-model=launchdarkly\.semanticpatch/);
  assert.deepEqual(sent[0].body.instructions, [{ kind: 'addTargets', contextKind: 'user', values: ['session-under-test'], variationId: promptedId }]);
  assert.equal(sent[0].body.environmentKey, LIVE_SETTINGS.LAUNCHDARKLY_ENVIRONMENT_KEY);
  assert.equal(launchDarkly.standIn.targets.get('someone-else'), variationIndex(launchDarkly.standIn, 'tooled'));
  assert.equal((await pageState(env)).config.name, 'v2 · prompted');
});

test('standalone, switch_travel_agent finds the workspace from PWD when the adapter starts it in the package', installedPackageTest, async (testContext) => {
  const workspace = await makeWorkspace(testContext);
  const gemini = await startGemini(testContext);
  const { BOOTHSTRAP_WORKSPACE: _, ...env } = await attemptEnvironment({ workspace, gemini });
  const setup = await runExecutable(path.join(await installPackageOnce(), 'setup'), [], { env, cwd: workspace });
  testContext.after(() => runExecutable(path.join(installRoot, 'launch-control', 'cleanup'), [], { env, cwd: workspace }));
  assert.equal(setup.code, 0, setup.stderr);

  const switched = await callSwitch({ ...env, PWD: workspace }, 2, await installPackageOnce());

  assert.equal(switched.isError, false, switched.text);
  assert.equal((await pageState(env)).config.name, 'v2 · prompted');
});

test('switch_travel_agent refuses, without patching, when the session is targeted to a variation off the ladder', installedPackageTest, async (testContext) => {
  const workspace = await makeWorkspace(testContext);
  const gemini = await startGemini(testContext);
  const launchDarkly = await startLaunchDarkly(testContext);
  const env = await attemptEnvironment({ workspace, gemini, launchDarkly });
  await setUpAttempt(testContext, env);
  launchDarkly.standIn.targets.set('session-under-test', variationIndex(launchDarkly.standIn, 'disabled'));
  const patchesBefore = patches(launchDarkly.standIn).length;

  const switched = await callSwitch(env, 2);

  assert.equal(switched.isError, true);
  assert.match(switched.text, /targeted to disabled, which is not on the ladder/);
  assert.equal(patches(launchDarkly.standIn).length, patchesBefore);
});

test('setup removes a target this session left behind, so the attempt starts on v1', installedPackageTest, async (testContext) => {
  const workspace = await makeWorkspace(testContext);
  const gemini = await startGemini(testContext);
  const launchDarkly = await startLaunchDarkly(testContext);
  const env = await attemptEnvironment({ workspace, gemini, launchDarkly });
  launchDarkly.standIn.targets.set('session-under-test', variationIndex(launchDarkly.standIn, 'upgraded'));
  launchDarkly.standIn.targets.set('someone-else', variationIndex(launchDarkly.standIn, 'upgraded'));

  const setup = await setUpAttempt(testContext, env);

  assert.match(setup.stdout, /\(live mode\)/);
  assert.equal(launchDarkly.standIn.targets.has('session-under-test'), false);
  assert.equal(launchDarkly.standIn.targets.has('someone-else'), true);
  assert.deepEqual(patches(launchDarkly.standIn)[0].body.instructions, [
    { kind: 'removeTargets', contextKind: 'user', values: ['session-under-test'], variationId: launchDarkly.standIn.variations[variationIndex(launchDarkly.standIn, 'upgraded')]._id },
  ]);
  assert.equal((await pageState(env)).stateLine, 'booker-state v1 rung=1 tried=none booked=no mode=live');
});

test('cleanup removes the session target, and is a no-op when run again', installedPackageTest, async (testContext) => {
  const workspace = await makeWorkspace(testContext);
  const gemini = await startGemini(testContext);
  const launchDarkly = await startLaunchDarkly(testContext);
  const env = await attemptEnvironment({ workspace, gemini, launchDarkly });
  await setUpAttempt(testContext, env);
  await callSwitch(env, 2);

  const first = await runHook('cleanup', env);
  const patchesAfterFirst = patches(launchDarkly.standIn).length;
  const second = await runHook('cleanup', env);

  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(launchDarkly.standIn.targets.size, 0);
  assert.equal(patches(launchDarkly.standIn).length, patchesAfterFirst);
  assert.deepEqual(await readdir(workspace), []);
  await assert.rejects(fetch(`${pageOrigin(env)}/api/state`));
});

test('cleanup after a crash, with the runtime config gone, still removes the session target', installedPackageTest, async (testContext) => {
  const workspace = await makeWorkspace(testContext);
  const gemini = await startGemini(testContext);
  const launchDarkly = await startLaunchDarkly(testContext);
  const env = await attemptEnvironment({ workspace, gemini, launchDarkly });
  await setUpAttempt(testContext, env);
  await callSwitch(env, 2);
  const pid = Number(await readFile(path.join(workspace, '.launch-control', 'server.pid'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  await rm(path.join(workspace, '.launch-control'), { recursive: true, force: true });

  const cleanup = await runHook('cleanup', env);

  assert.equal(cleanup.code, 0, cleanup.stderr);
  assert.equal(launchDarkly.standIn.targets.has('session-under-test'), false);
});

test('cleanup with nothing set up exits 0 and sends LaunchDarkly nothing', installedPackageTest, async (testContext) => {
  const workspace = await makeWorkspace(testContext);
  const gemini = await startGemini(testContext);
  const launchDarkly = await startLaunchDarkly(testContext);
  const env = await attemptEnvironment({ workspace, gemini, launchDarkly });

  const cleanup = await runHook('cleanup', env);

  assert.equal(cleanup.code, 0, cleanup.stderr);
  assert.equal(patches(launchDarkly.standIn).length, 0);
});

test('no credential appears in a page asset, response, workspace file, tool result, or hook output', installedPackageTest, async (testContext) => {
  const workspace = await makeWorkspace(testContext);
  const gemini = await startGemini(testContext);
  const launchDarkly = await startLaunchDarkly(testContext);
  const env = await attemptEnvironment({ workspace, gemini, launchDarkly });
  const setup = await setUpAttempt(testContext, env);
  const seen = [setup.stdout, setup.stderr];
  for (const pathname of ['/', '/app.mjs', '/styles.css', '/api/state', '/api/history', '/nowhere']) {
    const { response, text } = await fetchText(env, pathname);
    seen.push(text, JSON.stringify([...response.headers]));
  }
  seen.push((await sendChat(env)).text);
  for (const rung of [2, 3]) {
    seen.push((await callSwitch(env, rung)).output);
  }
  seen.push((await sendChat(env)).text);
  for (const rung of [4, 1, 3]) {
    seen.push((await callSwitch(env, rung)).output);
  }
  for (const file of ['travel-desk-state.json', 'itinerary.json', '.launch-control/runtime-config.json']) {
    seen.push(await readFile(path.join(workspace, file), 'utf8'));
  }
  const serverPid = Number(await readFile(path.join(workspace, '.launch-control', 'server.pid'), 'utf8'));
  const serverEnvironment = process.platform === 'linux' ? await readFile(`/proc/${serverPid}/environ`, 'utf8') : '';

  const cleanup = await runHook('cleanup', env);

  seen.push(cleanup.stdout, cleanup.stderr);
  for (const secret of SECRETS) {
    assert.ok(seen.every((text) => !text.includes(secret)), `${secret.split('-')[0]} credential leaked`);
  }
  const streamRequests = launchDarkly.standIn.requests.filter((request) => request.path === '/all');
  const restRequests = launchDarkly.standIn.requests.filter((request) => request.path !== '/all');
  assert.ok(streamRequests.length > 0 && streamRequests.every((request) => request.authorization === SDK_KEY));
  assert.ok(restRequests.length > 0 && restRequests.every((request) => request.authorization === API_TOKEN));
  assert.ok(gemini.requests.every((request) => request.apiKey === GEMINI_KEY));
  if (process.platform === 'linux') {
    assert.ok(!serverEnvironment.includes(API_TOKEN), 'the page server received the API token');
    assert.ok(serverEnvironment.includes(SDK_KEY));
  }
});

test('the page server serves the page under a strict CSP with no inline script or style', installedPackageTest, async (testContext) => {
  const workspace = await makeWorkspace(testContext);
  const gemini = await startGemini(testContext);
  const env = await attemptEnvironment({ workspace, gemini });
  await setUpAttempt(testContext, env);

  const { response, text } = await fetchText(env, '/');

  assert.equal(response.headers.get('content-security-policy').split(';')[0], "default-src 'self'");
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'; style-src 'self';.*connect-src 'self'/);
  assert.doesNotMatch(text, /<script>|<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/);
  assert.match(text, /<script type="module" src="\/app.mjs"><\/script>/);
});

test('the page server refuses chat from another origin and requests by a non-loopback host', installedPackageTest, async (testContext) => {
  const workspace = await makeWorkspace(testContext);
  const gemini = await startGemini(testContext);
  const env = await attemptEnvironment({ workspace, gemini });
  await setUpAttempt(testContext, env);

  const crossOrigin = await fetchText(env, '/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ message: TRIP }),
  });
  const rebound = await new Promise((resolve, reject) => {
    const probe = request(`${pageOrigin(env)}/api/state`, { headers: { host: 'evil.example' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    probe.once('error', reject);
    probe.end();
  });

  assert.equal(crossOrigin.response.status, 403);
  assert.equal(rebound, 421);
  assert.equal(gemini.requests.length, 0);
});

test("setup keeps the page server in setup's own process group", installedPackageTest, async (testContext) => {
  if (process.platform === 'win32') {
    testContext.skip('process groups are a POSIX feature');

    return;
  }
  const workspace = await makeWorkspace(testContext);
  const gemini = await startGemini(testContext);
  const env = await attemptEnvironment({ workspace, gemini });
  await setUpAttempt(testContext, env);

  const pid = Number(await readFile(path.join(workspace, '.launch-control', 'server.pid'), 'utf8'));
  const { stdout } = await runExecutable('ps', ['-o', 'pgid=', '-p', String(pid)]);

  assert.equal(Number(stdout.trim()), Number((await runExecutable('ps', ['-o', 'pgid=', '-p', String(process.pid)])).stdout.trim()));
});

test('setup fails naming the missing Gemini key, and starts no server', installedPackageTest, async (testContext) => {
  const workspace = await makeWorkspace(testContext);
  const gemini = await startGemini(testContext);
  const { GEMINI_API_KEY: _, ...env } = await attemptEnvironment({ workspace, gemini });

  const setup = await runHook('setup', env);

  assert.equal(setup.code, 1);
  assert.match(setup.stderr, /GEMINI_API_KEY is not set/);
  await assert.rejects(fetch(`${pageOrigin(env)}/api/state`));
});

/**
 * Start a fake of the LaunchDarkly REST endpoints provision.mjs uses: AI tools, an AI Config with
 * variations, and its targeting. It keeps what is created and records every request.
 */
async function startManagementApi(testContext) {
  const requests = [];
  const tools = new Map();
  const configs = new Map();
  const base = `/api/v2/projects/${LIVE_SETTINGS.LAUNCHDARKLY_PROJECT_KEY}`;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body = text === '' ? undefined : JSON.parse(text);
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      requests.push({ method: request.method, path: pathname, authorization: request.headers.authorization, body });
      const answer = (status, value) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(value === undefined ? '' : JSON.stringify(value));
      };
      const [, kind, key, child, childKey] = pathname.slice(base.length).split('/');
      if (kind === 'ai-tools') {
        if (request.method === 'POST') {
          tools.set(body.key, { ...body, version: 1 });
          return answer(201, tools.get(body.key));
        }
        if (!tools.has(key)) {
          return answer(404, { message: 'not found' });
        }
        if (request.method === 'PATCH') {
          tools.set(key, { ...tools.get(key), ...body, version: tools.get(key).version + 1 });
        }
        return answer(200, tools.get(key));
      }
      if (kind === 'ai-configs' && request.method === 'POST' && key === undefined) {
        configs.set(body.key, { key: body.key, mode: body.mode, variations: [] });
        return answer(201, configs.get(body.key));
      }
      const config = configs.get(key);
      if (config === undefined) {
        return answer(404, { message: 'not found' });
      }
      if (child === 'variations' && request.method === 'POST') {
        config.variations.push({ ...body, _id: `id-${body.key}` });
        return answer(201, {});
      }
      if (child === 'variations' && request.method === 'PATCH') {
        Object.assign(config.variations.find((variation) => variation.key === childKey), body);
        return answer(200, {});
      }
      if (child === 'targeting') {
        return answer(200, { variations: config.variations });
      }
      return answer(200, config);
    });
  });
  const origin = await listen(server);
  testContext.after(() => server.close());

  return { origin, requests, tools, configs };
}

/** Run provision.mjs against `api` with the test settings and token. */
function runProvision(api) {
  return runExecutable(process.execPath, [path.join(packageDirectory, 'provision.mjs')], {
    env: { PATH: process.env.PATH, ...LIVE_SETTINGS, LAUNCHDARKLY_API_AUTH_TOKEN: API_TOKEN, LAUNCH_CONTROL_LAUNCHDARKLY_ORIGIN: api.origin },
  });
}

test('provision.mjs creates the tools, the agent-mode config, its four variations, and a v1 default rule', async (testContext) => {
  const api = await startManagementApi(testContext);

  const provisioned = await runProvision(api);

  const config = api.configs.get(LIVE_SETTINGS.LAUNCHDARKLY_AI_CONFIG_KEY);
  const fallthrough = api.requests.find((request) => request.path.endsWith('/targeting') && request.method === 'PATCH');
  assert.equal(provisioned.code, 0, provisioned.stderr);
  assert.deepEqual([...api.tools.keys()], Object.keys(ladder.tools));
  assert.equal(config.mode, 'agent');
  assert.deepEqual(
    config.variations.map(({ key, modelConfigKey, tools }) => ({ key, modelConfigKey, tools: tools.map((tool) => tool.key) })),
    ladder.rungs.map((rung) => ({ key: rung.key, modelConfigKey: `Gemini.${rung.model}`, tools: rung.tools })),
  );
  assert.deepEqual(fallthrough.body.instructions, [{ kind: 'updateFallthroughVariationOrRollout', variationId: 'id-bare' }]);
  assert.equal(fallthrough.body.environmentKey, LIVE_SETTINGS.LAUNCHDARKLY_ENVIRONMENT_KEY);
  assert.ok(api.requests.every((request) => request.authorization === API_TOKEN));
  assert.ok(!provisioned.stdout.includes(API_TOKEN) && !provisioned.stderr.includes(API_TOKEN));
});

test('provision.mjs run a second time creates nothing and leaves the tool versions alone', async (testContext) => {
  const api = await startManagementApi(testContext);
  await runProvision(api);
  const firstRunRequests = api.requests.length;

  const again = await runProvision(api);

  const secondRun = api.requests.slice(firstRunRequests);
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(secondRun.filter((request) => request.method === 'POST'), []);
  assert.deepEqual(secondRun.filter((request) => request.method === 'PATCH' && request.path.includes('/ai-tools/')), []);
  assert.ok([...api.tools.values()].every((tool) => tool.version === 1));
});

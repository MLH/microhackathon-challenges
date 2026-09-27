import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('../local-vibe-coding/', import.meta.url));

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'vibe-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function run(file, args, options = {}) {
  const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, 'exit');
  return { code, signal, stdout, stderr };
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForReady(url, token, child) {
  for (let i = 0; i < 100; i++) {
    try {
      if (await ownsPreview(url, token)) return;
    } catch { /* not listening yet */ }
    if (child.exitCode !== null) throw new Error(`preview exited ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('preview did not become ready');
}

async function ownsPreview(url, token) {
  const nonce = randomBytes(16).toString('hex');
  const result = await fetch(`${url}__status`, { headers: { 'x-local-vibe-nonce': nonce } });
  return result.status === 204 && result.headers.get('x-local-vibe-proof') === createHmac('sha256', token).update(nonce).digest('hex');
}

async function stopPreview(workspace, port) {
  const token = (await readFile(join(workspace, '.local-vibe-state'), 'utf8')).trim();
  await fetch(`http://127.0.0.1:${port}/__stop`, { method: 'POST', headers: { 'x-local-vibe-token': token } });
}

test('portable package offers a three-step local-only Pi challenge and a complete dice reference', async () => {
  const manifest = JSON.parse(await readFile(join(packageDir, 'challenge.json'), 'utf8'));
  const plugin = JSON.parse(await readFile(join(packageDir, 'plugin.json'), 'utf8'));
  const skill = await readFile(join(packageDir, 'skills/start-challenge/SKILL.md'), 'utf8');
  const monitor = await readFile(join(packageDir, manifest.browser.monitor_skill), 'utf8');
  const sheet = await readFile(join(packageDir, 'dice-sheet.md'), 'utf8');
  assert.equal(manifest.id, 'local-vibe-coding');
  assert.equal(manifest.type, 'browser');
  assert.equal(manifest.browser.start_url, 'http://127.0.0.1:4321/');
  assert.equal(manifest.agent, 'pi');
  assert.equal(manifest.model, 'google/gemini-3.8-flash');
  assert.deepEqual(manifest.vault_services, ['gemini']);
  assert.deepEqual(manifest.steps.map((step) => step.id), ['fill-prompt', 'build-app', 'improve-app']);
  assert.equal(plugin.name, manifest.id);
  assert.equal((await readFile(join(packageDir, 'package.json'), 'utf8')).includes('"0.87.1"'), true);
  assert.ok((await readFile(join(packageDir, 'package-lock.json'), 'utf8')).includes('pi-tui'));
  assert.match(skill, /^---\nname: start-challenge\ndescription: .+\n---\n/);
  assert.match(monitor, /never report|do not report/i);
  assert.match(skill, /report_step/);
  assert.match(skill, /confirm/i);
  for (const [heading, size] of [['Theme', 6], ['Subject', 6], ['Audience', 20], ['Style', 20]]) {
    const section = sheet.split(`## ${heading} (d${size})`)[1]?.split('\n## ')[0];
    assert.ok(section, `${heading} section exists`);
    const faces = [...section.matchAll(/^\| (\d+) \|/gm)].map((match) => Number(match[1]));
    assert.deepEqual(faces, Array.from({ length: size }, (_, i) => i + 1));
  }
  assert.match(sheet, /Exhausted night-shift nurses/);
  assert.match(sheet, /Neon Noir/);
  assert.ok(!(await readdir(packageDir)).includes('mcp.json'));
});

test('hooks preserve participant work and tolerate repeat or partial cleanup', async (t) => {
  const root = await scratch(t);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const port = await freePort();
  const env = { ...process.env, NODE_ENV: 'test', LOCAL_VIBE_TEST_PORT: String(port), BOOTHSTRAP_WORKSPACE: workspace };
  t.after(async () => {
    if (existsSync(join(workspace, '.local-vibe-state'))) await stopPreview(workspace, port).catch(() => {});
  });
  assert.equal((await run(join(packageDir, 'cleanup'), [], { cwd: root, env })).code, 0);
  assert.equal((await run(join(packageDir, 'setup'), [], { cwd: root, env })).code, 0);
  const token = await readFile(join(workspace, '.local-vibe-state'), 'utf8');
  const sheet = await readFile(join(workspace, 'dice-sheet.md'), 'utf8');
  assert.match(sheet, /Neon Noir/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  await writeFile(join(workspace, 'index.html'), '<p>My app</p>');
  await writeFile(join(workspace, 'dice-sheet.md'), 'participant annotations');
  assert.equal((await run(join(packageDir, 'setup'), [], { cwd: root, env })).code, 0);
  assert.equal(await readFile(join(workspace, '.local-vibe-state'), 'utf8'), token);
  assert.equal(await readFile(join(workspace, 'dice-sheet.md'), 'utf8'), 'participant annotations');
  assert.equal(await readFile(join(workspace, 'index.html'), 'utf8'), '<p>My app</p>');
  await stopPreview(workspace, port);
  assert.equal((await run(join(packageDir, 'cleanup'), [], { cwd: root, env })).code, 0);
  assert.equal((await run(join(packageDir, 'cleanup'), [], { cwd: root, env })).code, 0);
  const retained = await readdir(workspace);
  assert.deepEqual(retained.filter((name) => !name.startsWith('.local-vibe-preview-')).sort(), ['dice-sheet.md', 'index.html']);
  assert.equal(retained.filter((name) => name.startsWith('.local-vibe-preview-')).length, 1);
  assert.equal((await run(join(packageDir, 'cleanup'), [], { cwd: root, env: { ...env, BOOTHSTRAP_WORKSPACE: join(root, 'missing') } })).code, 0);
});

test('setup does not follow disposable-state or log symlinks out of the workspace', async (t) => {
  const root = await scratch(t);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const outsideState = join(root, 'outside-state.txt');
  const outsideLog = join(root, 'outside-log.txt');
  await writeFile(outsideState, 'untouched state');
  await writeFile(outsideLog, 'untouched log');
  await symlink(outsideState, join(workspace, '.local-vibe-state'));
  await symlink(outsideLog, join(workspace, '.local-vibe-preview.log'));
  const port = await freePort();
  const env = { ...process.env, NODE_ENV: 'test', LOCAL_VIBE_TEST_PORT: String(port), BOOTHSTRAP_WORKSPACE: workspace };
  t.after(async () => {
    if (existsSync(join(workspace, '.local-vibe-state'))) await stopPreview(workspace, port).catch(() => {});
  });
  const result = await run(join(packageDir, 'setup'), [], { cwd: root, env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(outsideState, 'utf8'), 'untouched state');
  assert.equal(await readFile(outsideLog, 'utf8'), 'untouched log');
  await stopPreview(workspace, port);
});

test('setup refuses a foreign listener and recovers only stale state', async (t) => {
  const root = await scratch(t);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const port = await freePort();
  const env = { ...process.env, NODE_ENV: 'test', LOCAL_VIBE_TEST_PORT: String(port), BOOTHSTRAP_WORKSPACE: workspace };
  const listener = createServer((req, res) => req.url === '/__status'
    ? res.writeHead(204).end()
    : res.writeHead(200).end('foreign'));
  listener.listen(port, '127.0.0.1');
  await once(listener, 'listening');
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  await writeFile(join(workspace, '.local-vibe-state'), 'stale-token\n');
  const failed = await run(join(packageDir, 'setup'), [], { cwd: root, env });
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /preview failed to start/);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'foreign');
  await new Promise((resolve) => listener.close(resolve));
  const started = await run(join(packageDir, 'setup'), [], { cwd: root, env });
  assert.equal(started.code, 0, started.stderr);
  assert.notEqual((await readFile(join(workspace, '.local-vibe-state'), 'utf8')).trim(), 'stale-token');
  await stopPreview(workspace, port);
  await run(join(packageDir, 'cleanup'), [], { cwd: root, env });
});

test('overlapping setup calls leave an owned and stoppable preview', async (t) => {
  const root = await scratch(t);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const port = await freePort();
  const env = { ...process.env, NODE_ENV: 'test', LOCAL_VIBE_TEST_PORT: String(port), BOOTHSTRAP_WORKSPACE: workspace };
  t.after(async () => {
    if (existsSync(join(workspace, '.local-vibe-state'))) await stopPreview(workspace, port).catch(() => {});
  });
  const results = await Promise.all([run(join(packageDir, 'setup'), [], { cwd: root, env }), run(join(packageDir, 'setup'), [], { cwd: root, env })]);
  assert.ok(results.every((result) => result.code === 0), JSON.stringify(results));
  const token = (await readFile(join(workspace, '.local-vibe-state'), 'utf8')).trim();
  assert.equal(await ownsPreview(`http://127.0.0.1:${port}/`, token), true);
  await stopPreview(workspace, port);
  await run(join(packageDir, 'cleanup'), [], { cwd: root, env });
});

test('losing setup waits for a delayed winning ownership marker', async (t) => {
  const workspace = await scratch(t);
  const port = await freePort();
  const token = randomBytes(32).toString('hex');
  const url = `http://127.0.0.1:${port}/`;
  const env = { ...process.env, NODE_ENV: 'test', LOCAL_VIBE_TEST_PORT: String(port), BOOTHSTRAP_WORKSPACE: workspace };
  const winner = spawn(process.execPath, [join(packageDir, 'preview.mjs'), workspace], {
    stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, LOCAL_VIBE_TOKEN: token },
  });
  t.after(async () => {
    if (winner.exitCode === null) winner.kill('SIGTERM');
    if (winner.exitCode === null) await once(winner, 'exit');
  });
  await waitForReady(url, token, winner);
  const loser = spawn(join(packageDir, 'setup'), [], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const loserExit = once(loser, 'exit');
  t.after(() => { if (loser.exitCode === null) loser.kill('SIGTERM'); });
  const firstMiss = new Promise((resolve) => {
    loser.stderr.on('data', (chunk) => {
      if (chunk.toString().includes('waiting briefly for another setup')) resolve();
    });
  });
  let timer;
  try {
    await Promise.race([firstMiss, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('loser did not reach the ownership retry')), 3000); })]);
  } finally { clearTimeout(timer); }
  await writeFile(join(workspace, '.local-vibe-state'), token + '\n');
  const [code] = await loserExit;
  assert.equal(code, 0);
  assert.equal(await ownsPreview(url, token), true);
  await stopPreview(workspace, port);
  await run(join(packageDir, 'cleanup'), [], { cwd: workspace, env });
});

test('interrupting setup after spawn stops only its own unfinished preview', async (t) => {
  const root = await scratch(t);
  const workspace = join(root, 'workspace');
  const bin = join(root, 'bin');
  await mkdir(workspace);
  await mkdir(bin);
  const node = join(bin, 'node');
  await writeFile(node, `#!/bin/sh\ncase "$1" in */preview.mjs) echo $$ > "$BOOTHSTRAP_WORKSPACE/preview-pid"; exec sleep 30;; esac\nexec "${process.execPath}" "$@"\n`);
  await chmod(node, 0o755);
  const port = await freePort();
  const env = { ...process.env, NODE_ENV: 'test', LOCAL_VIBE_TEST_PORT: String(port), BOOTHSTRAP_WORKSPACE: workspace, PATH: `${bin}:${process.env.PATH}` };
  const child = spawn(join(packageDir, 'setup'), [], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const childExit = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let pid;
  for (let i = 0; i < 100; i++) {
    try { pid = Number(await readFile(join(workspace, 'preview-pid'), 'utf8')); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 20)); }
  }
  assert.ok(pid, 'preview child started');
  child.kill('SIGTERM');
  const [code] = await childExit;
  assert.notEqual(code, 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.ok(!existsSync(join(workspace, '.local-vibe-state')));
});

test('Pi form opens after one successful welcome, navigates fields, previews and sends once', async () => {
  const { default: register } = await import('../local-vibe-coding/prompt-flow.mjs');
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const sent = [];
  let form;
  let finishForm;
  let rendered = 0;
  class Input {
    constructor() { this.value = ''; this.focused = false; }
    getValue() { return this.value; }
    setValue(value) { this.value = value; }
    handleInput(key) { if (key.length === 1 && key !== '\r') this.value += key; }
    render() { return [this.value]; }
    invalidate() {}
  }
  const kit = {
    Input,
    matchesKey: (data, key) => data === key,
    truncateToWidth: (text, width) => text.slice(0, width),
    wrapTextWithAnsi: (text, width) => [text.slice(0, width)],
  };
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendUserMessage: (text) => {
      sent.push(text);
      entries.push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } });
    },
  };
  register(pi, kit);
  let editor = 'an unrelated draft';
  const notices = [];
  const ctx = { mode: 'tui', isIdle: () => true, sessionManager: { getBranch: () => entries }, ui: {
    getEditorText: () => editor,
    setEditorText: (text) => { editor = text; },
    notify: (text) => notices.push(text),
    custom: (factory) => new Promise((resolve) => {
      finishForm = resolve;
      form = factory({ requestRender: () => { rendered++; } }, { fg: (_name, text) => text, bold: (text) => text }, {}, resolve);
    }),
  } };
  await handlers.get('session_start')({ reason: 'startup' }, ctx);
  assert.equal(editor, 'an unrelated draft');
  await handlers.get('agent_before_settle')({ outcome: 'completed' }, ctx);
  const opened = handlers.get('agent_settled')({}, ctx);
  assert.ok(form);
  assert.match(form.render(60).join('\n'), /Theme.*Subject.*Audience.*Style.*Build/s);
  for (const [i, answer] of ['Game', 'Music', 'Librarians', 'Neon Noir'].entries()) {
    for (const char of answer) form.handleInput(char);
    if (i < 3) form.handleInput('tab');
  }
  form.invalidate();
  assert.match(form.render(60).join('\n'), /Build a Game about Music for Librarians in Neon Noir style\./);
  form.handleInput('shift+tab');
  form.handleInput('tab');
  form.handleInput('tab'); // Build
  assert.deepEqual(sent, []);
  form.handleInput('enter');
  await opened;
  assert.deepEqual(sent, ['Build a Game about Music for Librarians in Neon Noir style.']);
  assert.equal(editor, 'an unrelated draft');
  assert.ok(rendered > 0);
  assert.equal(entries.length, 1);
  assert.ok(finishForm);
  await handlers.get('agent_settled')({}, ctx);
  assert.equal(sent.length, 1);
  await commands.get('mad-libs').handler('', ctx);
  assert.equal(sent.length, 1);
  assert.ok(notices.length);
});

test('Pi form cancellation and failed welcome preserve fallback and session state', async () => {
  const { default: register } = await import('../local-vibe-coding/prompt-flow.mjs');
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const sent = [];
  let form;
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendUserMessage: (text) => sent.push(text),
  };
  class Input {
    constructor() { this.value = ''; this.cursor = 0; this.focused = false; }
    getValue() { return this.value; }
    setValue(value) { this.value = value; this.cursor = Math.min(this.cursor, value.length); }
    handleInput(key) { this.value = this.value.slice(0, this.cursor) + key + this.value.slice(this.cursor); this.cursor += key.length; }
    render() { return [this.value]; }
    invalidate() {}
  }
  const kit = { Input, matchesKey: (a, b) => a === b, truncateToWidth: (s, n) => s.slice(0, n), wrapTextWithAnsi: (s, n) => [s.slice(0, n)] };
  let editor = '';
  const notices = [];
  const ctx = { mode: 'tui', isIdle: () => true, sessionManager: { getBranch: () => entries }, ui: {
    getEditorText: () => editor,
    setEditorText: (text) => { editor = text; },
    notify: (text) => notices.push(text),
    custom: (factory) => new Promise((done) => { form = factory({ requestRender() {} }, { fg: (_name, text) => text, bold: (text) => text }, {}, done); }),
  } };
  register(pi, kit);
  await handlers.get('session_start')({ reason: 'startup' }, ctx);
  await handlers.get('agent_before_settle')({ outcome: 'error' }, ctx);
  await handlers.get('agent_settled')({}, ctx);
  assert.equal(form, undefined);
  await handlers.get('agent_before_settle')({ outcome: 'completed' }, ctx);
  await handlers.get('agent_settled')({}, ctx);
  assert.equal(form, undefined, 'later turns do not surprise-open the form');
  const firstOpen = commands.get('mad-libs').handler('', ctx);
  form.handleInput('X');
  form.handleInput('escape');
  await firstOpen;
  assert.deepEqual(sent, []);
  const secondOpen = commands.get('mad-libs').handler('', ctx);
  assert.match(form.render(40).join('\n'), /X/);
  form.handleInput('Y');
  assert.match(form.render(40).join('\n'), /XY/, 'typing after reopening appends to the answer');
  form.handleInput('tab'); // Subject
  form.handleInput('tab'); // Audience
  form.handleInput('tab'); // Style
  form.handleInput('tab'); // Build
  form.handleInput('enter'); // Incomplete: stay open
  assert.deepEqual(sent, []);
  assert.match(form.render(40).join('\n'), /required/i);
  form.handleInput('escape');
  await secondOpen;
  assert.deepEqual(sent, []);
  assert.equal(editor, '');
  assert.deepEqual(await handlers.get('input')({ source: 'interactive', text: 'Can you help me?' }, ctx), { action: 'continue' });
  assert.equal(entries.length, 0);
  assert.deepEqual(await handlers.get('input')({ source: 'interactive', text: 'Build a game about music' }, ctx), { action: 'handled' });
  assert.equal(editor, 'Build a game about music');
  assert.deepEqual(await handlers.get('input')({ source: 'interactive', text: 'Build a [Theme] about music for nurses in Neon Noir style.' }, ctx), { action: 'handled' });
  assert.deepEqual(await handlers.get('input')({ source: 'interactive', text: 'Build a Game about Music for Nurses in Neon Noir style.' }, ctx), { action: 'continue' });
  assert.deepEqual(await handlers.get('input')({ source: 'interactive', text: 'Build a [Theme] about Music for Nurses in Neon Noir style.' }, ctx), { action: 'handled' }, 'failed manual preflight must not bypass the blank guard');
  assert.deepEqual(await handlers.get('input')({ source: 'interactive', text: 'Build a Game about Music for Nurses in Neon Noir style.' }, ctx), { action: 'continue' });
  entries.push({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Build a Game about Music for Nurses in Neon Noir style.' }] } });
  assert.equal(entries.length, 1);
  register(pi, kit);
  await handlers.get('session_start')({ reason: 'reload' }, ctx);
  await handlers.get('agent_before_settle')({ outcome: 'completed' }, ctx);
  await handlers.get('agent_settled')({}, ctx);
  assert.deepEqual(await handlers.get('input')({ source: 'interactive', text: 'Build a [Theme] selector' }, ctx), { action: 'continue' });
  assert.deepEqual(await handlers.get('input')({ source: 'interactive', text: 'Change the label to [Theme].' }, ctx), { action: 'continue' });
  assert.ok(notices.some((text) => text.includes('Build a [Theme]')));
});

test('failed Pi preflight leaves the form reopenable with all answers', async () => {
  const { default: register } = await import('../local-vibe-coding/prompt-flow.mjs');
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const sent = [];
  let form;
  class Input {
    constructor() { this.value = ''; this.focused = false; }
    getValue() { return this.value; }
    setValue(value) { this.value = value; }
    handleInput(key) { this.value += key; }
    render() { return [this.value]; }
    invalidate() {}
  }
  const kit = { Input, matchesKey: (a, b) => a === b, truncateToWidth: (s, n) => s.slice(0, n), wrapTextWithAnsi: (s, n) => [s.slice(0, n)] };
  register({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    sendUserMessage: (text) => sent.push(text), // Pi rejects this async; no user message is persisted.
  }, kit);
  const ctx = { mode: 'tui', isIdle: () => true, sessionManager: { getBranch: () => entries }, ui: {
    notify() {},
    custom: (factory) => new Promise((done) => { form = factory({ requestRender() {} }, { fg: (_name, text) => text, bold: (text) => text }, {}, done); }),
  } };
  handlers.get('session_start')({ reason: 'startup' }, ctx);
  const first = commands.get('mad-libs').handler('', ctx);
  for (const answer of ['Game', 'Music', 'Nurses', 'Neon']) {
    for (const char of answer) form.handleInput(char);
    form.handleInput('tab');
  }
  form.handleInput('enter');
  await first;
  assert.equal(sent.length, 1);
  const previousForm = form;
  const retry = commands.get('mad-libs').handler('', ctx);
  assert.notEqual(form, previousForm, 'reopens after an unaccepted send');
  assert.ok(form.render(80).join('\n').includes('Neon'));
  form.handleInput('escape');
  await retry;
});

test('localhost preview serves only the HTML app and reloads while preserving the source file', async (t) => {
  const root = await scratch(t);
  const port = await freePort();
  const token = 'a-test-only-secret';
  const url = `http://127.0.0.1:${port}/`;
  const child = spawn(process.execPath, [join(packageDir, 'preview.mjs'), root], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test', LOCAL_VIBE_TEST_PORT: String(port), LOCAL_VIBE_TOKEN: token },
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
  });
  await waitForReady(url, token, child);
  assert.equal((await fetch(url + '__status')).status, 403);
  assert.equal((await fetch(url + '__stop', { method: 'POST', headers: { 'x-local-vibe-token': 'bad' } })).status, 403);
  assert.equal((await fetch(url + '__stop', { method: 'POST', headers: { 'x-local-vibe-token': token, Origin: 'https://attacker.example' } })).status, 403);
  const waiting = await fetch(url);
  assert.equal(waiting.status, 200);
  assert.match(await waiting.text(), /Waiting for index\.html/);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    get(url, { headers: { Host: 'attacker.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  const app = '<!doctype html><title>Mine</title><button>Go</button>';
  await writeFile(join(root, 'index.html'), app);
  await writeFile(join(root, 'secret.txt'), 'private');
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(await response.text(), /EventSource/);
  assert.equal(await readFile(join(root, 'index.html'), 'utf8'), app);
  for (const path of ['secret.txt', '%2e%2e/secret.txt', '.local-vibe-state', 'dice-sheet.md', 'index.html/../secret.txt']) {
    const forbidden = await fetch(url + path);
    assert.notEqual(forbidden.status, 200, path);
  }
  await rm(join(root, 'index.html'));
  await symlink(join(root, 'secret.txt'), join(root, 'index.html'));
  assert.equal((await fetch(url)).status, 503, 'symlinked app must not expose a different file');
  await rm(join(root, 'index.html'));
  await writeFile(join(root, 'index.html'), app);
  const stream = await fetch(url + '__reload');
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  await writeFile(join(root, 'index.html'), app + '<p>changed</p>');
  let timer;
  const next = await Promise.race([
    reader.read(),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('reload timed out')), 2000); }),
  ]);
  clearTimeout(timer);
  assert.match(new TextDecoder().decode(next.value), /data: reload/);
  await reader.cancel();
});

test('standalone launcher primes Pi and stops its preview without deleting app or history', async (t) => {
  const parent = await scratch(t);
  const bin = join(parent, 'bin');
  await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node'));
  const fakePi = join(bin, 'pi');
  await writeFile(fakePi, '#!/bin/sh\nprintf "%s\\n" "$@" > pi-args.txt\nprintf "<!doctype html><p>kept</p>" > index.html\nwhile [ "$#" -gt 1 ]; do\n  if [ "$1" = "--session-dir" ]; then printf "saved" > "$2/conversation.jsonl"; break; fi\n  shift\ndone\n');
  await chmod(fakePi, 0o755);
  const result = await run(join(packageDir, 'run'), [], {
    cwd: parent,
    env: { ...process.env, TMPDIR: parent, PATH: `${bin}:/usr/bin:/bin` },
  });
  assert.equal(result.code, 0, result.stderr);
  const workspace = result.stdout.match(/Workspace: (.+\/workspace)/)?.[1];
  assert.ok(workspace, result.stdout);
  assert.equal(dirname(dirname(workspace)), parent);
  assert.equal(await readFile(join(workspace, 'index.html'), 'utf8'), '<!doctype html><p>kept</p>');
  const args = await readFile(join(workspace, 'pi-args.txt'), 'utf8');
  assert.match(args, /--skill\n.*SKILL\.md/);
  assert.match(args, /--extension\n.*mad-libs\.mjs/);
  assert.match(args, /--session-dir\n/);
  assert.match(args, /\/skill:start-challenge/);
  assert.equal(await readFile(join(dirname(workspace), 'pi-sessions/conversation.jsonl'), 'utf8'), 'saved');
  assert.ok(!existsSync(join(workspace, '.local-vibe-state')));
  const previewUrl = result.stdout.match(/Preview: (http:\/\/127\.0\.0\.1:4321\/)/)?.[1];
  assert.ok(previewUrl, result.stdout);
  await assert.rejects(fetch(previewUrl), 'the launcher must stop its preview on exit');
});

test('standalone test-port override stops the preview it started', async (t) => {
  const parent = await scratch(t);
  const bin = join(parent, 'bin');
  await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node'));
  await writeFile(join(bin, 'pi'), '#!/bin/sh\n: > index.html\n');
  await chmod(join(bin, 'pi'), 0o755);
  const port = await freePort();
  const result = await run(join(packageDir, 'run'), [], {
    cwd: parent,
    env: { ...process.env, NODE_ENV: 'test', LOCAL_VIBE_TEST_PORT: String(port), TMPDIR: parent, PATH: `${bin}:/usr/bin:/bin` },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Preview: http://127\\.0\\.0\\.1:${port}/`));
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
});

test('launcher rejects missing Pi before creating a workspace or starting a preview', async (t) => {
  const parent = await scratch(t);
  const bin = join(parent, 'bin');
  await mkdir(bin);
  await symlink(process.execPath, join(bin, 'node'));
  const result = await run(join(packageDir, 'run'), [], {
    cwd: parent,
    env: { ...process.env, TMPDIR: parent, PATH: `${bin}:/usr/bin:/bin` },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /pi is required/);
  assert.deepEqual((await readdir(parent)).sort(), ['bin']);
});

test('launcher aborts before Pi when preview startup fails', async (t) => {
  const parent = await scratch(t);
  const bin = join(parent, 'bin');
  await mkdir(bin);
  const fakeNode = join(bin, 'node');
  await writeFile(fakeNode, `#!/bin/sh\ncase "$1" in */preview.mjs) exit 9;; esac\nexec "${process.execPath}" "$@"\n`);
  await chmod(fakeNode, 0o755);
  await writeFile(join(bin, 'pi'), '#!/bin/sh\nprintf called > pi-was-called\n');
  await chmod(join(bin, 'pi'), 0o755);
  const result = await run(join(packageDir, 'run'), [], {
    cwd: parent,
    env: { ...process.env, TMPDIR: parent, PATH: `${bin}:/usr/bin:/bin` },
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /preview failed to start/);
  const workspace = result.stdout.match(/Workspace: (.+\/workspace)/)?.[1];
  assert.ok(workspace);
  assert.ok(!existsSync(join(workspace, 'pi-was-called')));
  assert.ok(!existsSync(join(workspace, '.local-vibe-state')));
});

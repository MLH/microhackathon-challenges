import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const challenge = fileURLToPath(new URL('../hello-world/', import.meta.url));

async function makeWorkspace(t) {
  const scratchBase = existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
  const root = await mkdtemp(join(scratchBase, 'hello-world-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  return workspace;
}

function runHook(name, cwd, workspace) {
  return execFileAsync(join(challenge, name), [], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: cwd,
      TMPDIR: cwd,
      ...(workspace === undefined ? {} : { BOOTHSTRAP_WORKSPACE: workspace }),
    },
  });
}

test('package exposes the two-step terminal contract and a portable skill', async () => {
  const manifest = JSON.parse(await readFile(join(challenge, 'challenge.json'), 'utf8'));
  const plugin = JSON.parse(await readFile(join(challenge, 'plugin.json'), 'utf8'));
  const skill = await readFile(join(challenge, 'skills/hello-world/SKILL.md'), 'utf8');

  assert.equal(manifest.id, 'hello-world');
  assert.equal(manifest.type, 'terminal');
  assert.equal(manifest.agent, 'pi');
  assert.equal(manifest.model, 'google/gemini-3.8-flash');
  assert.deepEqual(manifest.vault_services, ['gemini']);
  assert.equal(manifest.points, 50);
  assert.deepEqual(manifest.steps.map((step) => step.id), ['greet', 'hello-file']);
  for (const step of manifest.steps) {
    assert.ok(step.title && step.hint && step.done_when);
  }
  assert.ok((await readFile(join(challenge, manifest.intro), 'utf8')).length > 0);
  assert.equal(plugin.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(plugin.name, 'hello-world');
  assert.match(skill, /^---\nname: hello-world\ndescription: .+\n---\n/);
  assert.ok(!(await readdir(challenge)).includes('mcp.json'));
});

test('setup seeds the supplied workspace and cleanup is repeatable without deleting participant work', async (t) => {
  const workspace = await makeWorkspace(t);
  const cwd = await makeWorkspace(t);

  await runHook('setup', cwd, workspace);
  assert.match(await readFile(join(workspace, 'welcome.txt'), 'utf8'), /hello/i);
  await readFile(join(workspace, '.hello-world-state'), 'utf8');
  await writeFile(join(workspace, 'hello.txt'), 'Hello, world!\n');

  await runHook('cleanup', cwd, workspace);
  await runHook('cleanup', cwd, workspace);
  assert.deepEqual((await readdir(workspace)).sort(), ['hello.txt', 'welcome.txt']);
});

test('hooks use the current directory in standalone Pi and tolerate partial setup', async (t) => {
  const workspace = await makeWorkspace(t);

  await runHook('cleanup', workspace);
  await runHook('setup', workspace);
  assert.match(await readFile(join(workspace, 'welcome.txt'), 'utf8'), /hello/i);
  await runHook('cleanup', workspace);
  assert.deepEqual(await readdir(workspace), ['welcome.txt']);
});

test('setup fails clearly when the selected workspace does not exist', async (t) => {
  const cwd = await makeWorkspace(t);
  const missing = join(cwd, 'not-created');

  await assert.rejects(runHook('setup', cwd, missing), (error) => {
    assert.notEqual(error.code, 0);
    assert.match(error.stderr, /workspace/i);
    return true;
  });
  await assert.rejects(runHook('cleanup', cwd, missing), (error) => {
    assert.notEqual(error.code, 0);
    assert.match(error.stderr, /workspace/i);
    return true;
  });
});

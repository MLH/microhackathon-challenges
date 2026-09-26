#!/usr/bin/env node
import { createServer } from 'node:http';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { watch } from 'node:fs';
import { join, resolve } from 'node:path';

const [workspaceArg, readyArg] = process.argv.slice(2);
if (!workspaceArg || !readyArg) {
  console.error('usage: node preview.mjs <workspace> <ready-file>');
  process.exit(2);
}

const workspace = resolve(workspaceArg);
const readyFile = resolve(readyArg);
const appFile = join(workspace, 'index.html');
const reloadClients = new Set();
const reloadScript = '<script>new EventSource("/__reload").onmessage = () => location.reload();</script>';
const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

function html(res, source) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': policy,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  res.end(source.replace(/<\/body\s*>/i, `${reloadScript}</body>`) + (/<\/body\s*>/i.test(source) ? '' : reloadScript));
}

const server = createServer((req, res) => {
  // Loopback binding alone does not prevent a browser from reaching this
  // server through a hostname that has been rebound to 127.0.0.1.
  if (req.headers.host !== `127.0.0.1:${server.address().port}`) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
    return;
  }
  // Compare the raw path so encoded traversal cannot be normalized into an
  // allowed page by URL parsing. No file path comes from the request.
  const path = (req.url ?? '').split('?', 1)[0];
  if (req.method !== 'GET') {
    res.writeHead(405).end('method not allowed');
    return;
  }
  if (path === '/__reload') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.flushHeaders();
    reloadClients.add(res);
    req.on('close', () => reloadClients.delete(res));
    return;
  }
  if (path !== '/' && path !== '/index.html') {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  try {
    const stat = lstatSync(appFile);
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error('not a small regular file');
    html(res, readFileSync(appFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      html(res, '<!doctype html><title>Local Vibe Coding</title><p>Waiting for index.html…</p>');
    } else {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('app unavailable');
    }
  }
});

const watcher = watch(workspace, (_event, filename) => {
  if (filename !== 'index.html') return;
  for (const client of reloadClients) client.write('data: reload\n\n');
});

server.on('error', (error) => {
  console.error(`local preview: ${error.message}`);
  watcher.close();
  process.exitCode = 1;
});
server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}/`;
  try {
    writeFileSync(readyFile, url + '\n', { flag: 'wx' });
    console.log(`local preview: ${url}`);
  } catch (error) {
    console.error(`local preview: could not write ready file: ${error.message}`);
    process.exitCode = 1;
    watcher.close();
    server.close();
  }
});

process.on('SIGTERM', () => {
  watcher.close();
  for (const client of reloadClients) client.end();
  server.close();
});

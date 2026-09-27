#!/usr/bin/env node
import { createServer } from 'node:http';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { watch } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';

const [workspaceArg] = process.argv.slice(2);
const token = process.env.LOCAL_VIBE_TOKEN;
const port = process.env.NODE_ENV === 'test' && process.env.LOCAL_VIBE_TEST_PORT
  ? Number(process.env.LOCAL_VIBE_TEST_PORT) : 4321;
if (!workspaceArg || !token || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('usage: LOCAL_VIBE_TOKEN=<token> node preview.mjs <workspace>');
  process.exit(2);
}

const workspace = resolve(workspaceArg);
const appFile = join(workspace, 'index.html');
const reloadClients = new Set();
const reloadScript = '<script>new EventSource("/__reload").onmessage = () => location.reload();</script>';
const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";
const tokenBytes = Buffer.from(token);

function authorized(req) {
  const given = req.headers['x-local-vibe-token'];
  const bytes = typeof given === 'string' ? Buffer.from(given) : Buffer.alloc(0);
  return bytes.length === tokenBytes.length && timingSafeEqual(bytes, tokenBytes);
}

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
  if (req.headers.host !== `127.0.0.1:${port}`) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
    return;
  }
  // Compare the raw path so encoded traversal cannot be normalized into an
  // allowed page by URL parsing. No file path comes from the request.
  const path = (req.url ?? '').split('?', 1)[0];
  if (path === '/__status' || path === '/__stop') {
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${port}`) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (path === '/__status' && req.method === 'GET') {
      const nonce = req.headers['x-local-vibe-nonce'];
      if (typeof nonce !== 'string' || !/^[a-f0-9]{32}$/.test(nonce)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const proof = createHmac('sha256', token).update(nonce).digest('hex');
      res.writeHead(204, { 'cache-control': 'no-store', 'x-local-vibe-proof': proof }).end();
      return;
    }
    if (!authorized(req)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (path === '/__stop' && req.method === 'POST') {
      res.writeHead(204).end();
      setImmediate(() => {
        watcher.close();
        for (const client of reloadClients) client.end();
        server.close();
      });
      return;
    }
    res.writeHead(405).end('method not allowed');
    return;
  }
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
  let fd;
  try {
    fd = openSync(appFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 2_000_000) throw new Error('not a small regular file');
    html(res, readFileSync(fd, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      html(res, '<!doctype html><title>Local Vibe Coding</title><p>Waiting for index.html…</p>');
    } else {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('app unavailable');
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
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
server.listen(port, '127.0.0.1', () => {
  console.log(`local preview: http://127.0.0.1:${port}/`);
});

process.on('SIGTERM', () => {
  watcher.close();
  for (const client of reloadClients) client.end();
  server.close();
});

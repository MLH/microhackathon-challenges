/**
 * The page server: serves the built game, this attempt's runtime config, and the progress file
 * that lets a refresh or a restarted guide pick up the run. Node built-ins only, because a
 * Boothstrap package runs wherever it is unpacked and cannot import the repository's dependencies.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { MAX_PROGRESS_BYTES, parseProgress } from '../shared/progress.mjs';

/** The content types of the files the build produces. */
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** Headers every response carries: nothing is cached, because a replay must never see old state. */
const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

/** Send a JSON body. */
function sendJson(response, status, body) {
  response.writeHead(status, { ...BASE_HEADERS, 'content-type': CONTENT_TYPES['.json'] });
  response.end(JSON.stringify(body));
}

/** Send a status with no body. */
function sendStatus(response, status, message = '') {
  response.writeHead(status, { ...BASE_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
  response.end(message);
}

/** The origins a request may legitimately come from: this server, by IP or by name. */
function allowedOrigins(request) {
  const port = request.socket.localPort;

  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

/** Whether the request addresses this server by a loopback name, which defeats DNS rebinding. */
function hostIsLoopback(request) {
  const host = request.headers.host ?? '';

  return allowedOrigins(request).some((origin) => origin === `http://${host}`);
}

/** Whether a state-changing request came from this page rather than another site. */
function originIsOwn(request) {
  const origin = request.headers.origin;

  return origin === undefined || allowedOrigins(request).includes(origin);
}

/** Read the request body, refusing anything over `limit` bytes. */
async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk;
    size += buffer.length;
    if (size > limit) {
      return null;
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/** Write `contents` to `file` atomically, so a reader never sees half a file. */
async function writeAtomic(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, file);
}

/** Handle `/api/progress`. */
async function handleProgress(request, response, options) {
  if (request.method === 'GET') {
    try {
      const contents = await readFile(options.progressFile, 'utf8');
      response.writeHead(200, { ...BASE_HEADERS, 'content-type': CONTENT_TYPES['.json'] });
      response.end(contents);
    } catch {
      sendStatus(response, 204);
    }

    return;
  }

  if (!originIsOwn(request)) {
    sendStatus(response, 403, 'cross-origin writes are not allowed');

    return;
  }

  if (request.method === 'DELETE') {
    await rm(options.progressFile, { force: true });
    sendStatus(response, 204);

    return;
  }

  if (request.method !== 'PUT') {
    sendStatus(response, 405);

    return;
  }

  if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
    sendStatus(response, 415, 'progress must be JSON');

    return;
  }

  const body = await readBody(request, MAX_PROGRESS_BYTES);
  if (body === null) {
    sendStatus(response, 413, 'progress is too large');

    return;
  }

  try {
    const progress = parseProgress(JSON.parse(body));
    if (progress.attemptId !== options.runtimeConfig.attemptId) {
      sendStatus(response, 409, 'progress belongs to another attempt');

      return;
    }
    await writeAtomic(options.progressFile, `${JSON.stringify(progress, null, 2)}\n`);
    sendStatus(response, 204);
  } catch (error) {
    sendStatus(response, 400, error instanceof Error ? error.message : 'invalid progress');
  }
}

/** Serve a file from the game directory (or `/shared/`), with `/` meaning `index.html`. */
async function handleStatic(pathname, response, distDir) {
  const decoded = decodeURIComponent(pathname);
  const isShared = decoded.startsWith('/shared/');
  const baseDir = isShared ? path.resolve(distDir, '..', 'shared') : path.resolve(distDir);
  const relative =
    decoded === '/' ? 'index.html' : isShared ? decoded.slice('/shared/'.length) : decoded.slice(1);
  const file = path.resolve(baseDir, relative);
  if (!file.startsWith(`${baseDir}${path.sep}`)) {
    sendStatus(response, 404);

    return;
  }

  try {
    if (!(await stat(file)).isFile()) {
      sendStatus(response, 404);

      return;
    }
    const contents = await readFile(file);
    response.writeHead(200, {
      ...BASE_HEADERS,
      'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    });
    response.end(contents);
  } catch {
    sendStatus(response, 404);
  }
}

/** Create the page server. The caller decides when and where it listens. */
export function createPageServer(options) {
  return createServer((request, response) => {
    void (async () => {
      if (!hostIsLoopback(request)) {
        sendStatus(response, 403, 'this server answers to loopback names only');

        return;
      }

      const { pathname } = new URL(request.url ?? '/', 'http://localhost');
      if (pathname === '/healthz') {
        sendStatus(response, 200, 'ok');
      } else if (pathname === '/runtime-config.json') {
        sendJson(response, 200, options.runtimeConfig);
      } else if (pathname === '/api/progress') {
        await handleProgress(request, response, options);
      } else if (request.method === 'GET' || request.method === 'HEAD') {
        await handleStatic(pathname, response, options.distDir);
      } else {
        sendStatus(response, 405);
      }
    })().catch(() => {
      if (!response.headersSent) {
        sendStatus(response, 500);
      } else {
        response.end();
      }
    });
  });
}

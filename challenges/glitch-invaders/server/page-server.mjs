/**
 * The page server: serves the game, this attempt's runtime config, and the progress file
 * that lets a refresh or a restarted guide pick up the run. In live mode it also fetches Sentry's
 * record of the page's reports, so the token never reaches the page. Node built-ins only, because a
 * Boothstrap package runs wherever it is unpacked and cannot import the repository's dependencies.
 */
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { BUG_IDS, MAX_PROGRESS_BYTES, parseProgress } from '../shared/progress.mjs';
import { ingestOrigin } from '../shared/runtime-config.mjs';
import { SentryUnavailableError } from './sentry-api.mjs';
import {
  readWorkspaceFile,
  RefusedFileError,
  removeWorkspaceFile,
  writeWorkspaceFile,
} from './workspace-file.mjs';

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

/**
 * The page may load and contact nothing but this server, and in live mode Sentry's ingest origin
 * for the DSN, where it sends its reports.
 */
function contentSecurityPolicy(runtimeConfig) {
  const connect =
    runtimeConfig.sentry === undefined
      ? "'self'"
      : `'self' ${ingestOrigin(runtimeConfig.sentry.dsn)}`;

  return `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${connect}`;
}

/** The ids the page gives its Sentry reports: 32 lowercase hex digits for events and traces. */
const REPORT_ID_PATTERN = /^[0-9a-f]{32}$/;

/** How much of a refused upload the server reads and discards before it drops the connection. */
const MAX_DISCARDED_BYTES = 4 * MAX_PROGRESS_BYTES;

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

/** Read the request body, or resolve `null` and stop reading as soon as it passes `limit` bytes. */
function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    /** Collect a chunk, giving up once the body is too big. */
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        request.off('data', onData);
        request.off('end', onEnd);
        request.pause();
        resolve(null);

        return;
      }
      chunks.push(chunk);
    };

    /** Resolve with the whole body. */
    const onEnd = () => resolve(Buffer.concat(chunks).toString('utf8'));

    request.on('data', onData);
    request.on('end', onEnd);
    request.once('error', reject);
  });
}

/**
 * Answer 413, then read and discard the rest of the body so the client can finish sending and read
 * the answer instead of seeing a reset. Drops the connection once more than `MAX_DISCARDED_BYTES`
 * arrive, so an endless upload cannot hold it open.
 */
function refuseOversizedBody(request, response) {
  let discarded = 0;
  request.on('data', (chunk) => {
    discarded += chunk.length;
    if (discarded > MAX_DISCARDED_BYTES) {
      request.destroy();
    }
  });
  // readBody pauses the body when it gives up; a paused stream stays paused when a listener is added.
  request.resume();
  sendStatus(response, 413, 'progress is too large');
}

/** Send the stored progress: 204 when there is none, 422 when the file is not a lone regular file. */
async function sendProgress(response, progressFile) {
  let contents;
  try {
    contents = await readWorkspaceFile(progressFile, MAX_PROGRESS_BYTES);
  } catch (error) {
    if (error instanceof RefusedFileError) {
      sendStatus(response, 422, error.message);

      return;
    }
    throw error;
  }
  if (contents === null) {
    sendStatus(response, 204);

    return;
  }

  response.writeHead(200, { ...BASE_HEADERS, 'content-type': CONTENT_TYPES['.json'] });
  response.end(contents);
}

/** Validate a progress body as JSON for this attempt, or answer 400 or 409 and return `null`. */
function parseProgressBody(body, response, attemptId) {
  let progress;
  try {
    progress = parseProgress(JSON.parse(body));
  } catch (error) {
    sendStatus(response, 400, error instanceof Error ? error.message : 'invalid progress');

    return null;
  }
  if (progress.attemptId !== attemptId) {
    sendStatus(response, 409, 'progress belongs to another attempt');

    return null;
  }

  return progress;
}

/** Store a progress body: 204, or 400/409/413/415/422 without writing anything. */
async function saveProgress(request, response, options) {
  if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
    sendStatus(response, 415, 'progress must be JSON');

    return;
  }
  if (Number(request.headers['content-length']) > MAX_PROGRESS_BYTES) {
    refuseOversizedBody(request, response);

    return;
  }

  const body = await readBody(request, MAX_PROGRESS_BYTES);
  if (body === null) {
    refuseOversizedBody(request, response);

    return;
  }
  const progress = parseProgressBody(body, response, options.runtimeConfig.attemptId);
  if (progress === null) {
    return;
  }

  await answerRefusals(response, () =>
    writeWorkspaceFile(options.progressFile, `${JSON.stringify(progress, null, 2)}\n`),
  );
}

/** Run a workspace write and answer 204, or 422 when the file there is not a lone regular file. */
async function answerRefusals(response, write) {
  try {
    await write();
  } catch (error) {
    if (error instanceof RefusedFileError) {
      sendStatus(response, 422, error.message);

      return;
    }
    throw error;
  }
  sendStatus(response, 204);
}

/** Handle `/api/progress`. */
async function handleProgress(request, response, options) {
  if (request.method === 'GET') {
    await sendProgress(response, options.progressFile);

    return;
  }

  if (!originIsOwn(request)) {
    sendStatus(response, 403, 'cross-origin writes are not allowed');

    return;
  }

  if (request.method === 'DELETE') {
    await answerRefusals(response, () => removeWorkspaceFile(options.progressFile));

    return;
  }

  if (request.method !== 'PUT') {
    sendStatus(response, 405);

    return;
  }

  await saveProgress(request, response, options);
}

/**
 * Handle `/api/sentry-evidence?bug=<bug>&id=<report id>`: 200 with live evidence, 404 in demo
 * mode, 400 for a bad query, and 502 naming the problem when Sentry cannot provide it.
 */
async function handleSentryEvidence(request, response, options) {
  if (options.fetchEvidence === undefined) {
    sendStatus(response, 404);

    return;
  }
  if (request.method !== 'GET') {
    sendStatus(response, 405);

    return;
  }

  const query = new URL(request.url ?? '/', 'http://localhost').searchParams;
  const bug = query.get('bug');
  const id = query.get('id');
  if (!BUG_IDS.includes(bug) || id === null || !REPORT_ID_PATTERN.test(id)) {
    sendStatus(response, 400, 'bug must be weapon, shield, or boss, and id 32 hex digits');

    return;
  }

  try {
    sendJson(response, 200, await options.fetchEvidence(bug, id));
  } catch (error) {
    if (error instanceof SentryUnavailableError) {
      sendStatus(response, 502, error.message);

      return;
    }
    throw error;
  }
}

/** Serve a file from the game directory (or `/shared/`), with `/` meaning `index.html`. */
async function handleStatic(pathname, response, gameDir) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendStatus(response, 400, 'the path has a malformed percent-escape');

    return;
  }
  const isShared = decoded.startsWith('/shared/');
  const baseDir = isShared ? path.resolve(gameDir, '..', 'shared') : path.resolve(gameDir);
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

/**
 * Create the page server. The caller decides when and where it listens.
 *
 * @param {{ gameDir: string, progressFile: string, runtimeConfig: object,
 *   fetchEvidence?: (bug: string, id: string) => Promise<object> }} options `fetchEvidence` is
 *   given only in live mode.
 */
export function createPageServer(options) {
  const policy = contentSecurityPolicy(options.runtimeConfig);

  return createServer((request, response) => {
    response.setHeader('content-security-policy', policy);
    void (async () => {
      if (!hostIsLoopback(request)) {
        sendStatus(response, 403, 'this server answers to loopback names only');

        return;
      }

      const pathname = URL.parse(request.url ?? '/', 'http://localhost')?.pathname;
      if (pathname === undefined) {
        sendStatus(response, 400, 'the request target is not a URL path');
      } else if (pathname === '/healthz') {
        sendStatus(response, 200, 'ok');
      } else if (pathname === '/runtime-config.json') {
        sendJson(response, 200, options.runtimeConfig);
      } else if (pathname === '/api/progress') {
        await handleProgress(request, response, options);
      } else if (pathname === '/api/sentry-evidence') {
        await handleSentryEvidence(request, response, options);
      } else if (request.method === 'GET' || request.method === 'HEAD') {
        await handleStatic(pathname, response, options.gameDir);
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

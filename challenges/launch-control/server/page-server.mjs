/**
 * The page server: serves the travel desk page, the session's live booker config, and the chat,
 * running the booker's agent loop on the server so no key ever reaches the page. In demo mode it
 * also mounts the LaunchDarkly stand-in. It answers only requests that address it by a loopback
 * name, and takes chat messages only from its own page.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { GeminiError } from './gemini.mjs';
import { readBody, sendJson as sendJsonWithHeaders } from './http.mjs';
import { DEMO_PATH } from './settings.mjs';
import { writeWorkspaceFile } from './workspace-file.mjs';

/** The page's files and their content types; nothing else is served. */
const PAGE_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

/** The page may load and contact nothing but this server. */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Headers every response carries: nothing is cached, because the config can change at any time. */
const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': CONTENT_SECURITY_POLICY,
};

/** The longest chat message the booker takes. */
export const MAX_MESSAGE_CHARACTERS = 1_000;

/** The largest chat request body read. */
const MAX_BODY_BYTES = 8 * 1024;

/** Send a JSON body with the page server's headers. */
function sendJson(response, status, body) {
  sendJsonWithHeaders(response, status, body, BASE_HEADERS);
}

/** Send a status with a short plain-text reason. */
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
function isOwnPage(request) {
  const origin = request.headers.origin;
  const site = request.headers['sec-fetch-site'];

  return (origin === undefined || allowedOrigins(request).includes(origin)) && (site === undefined || site === 'same-origin');
}

/** The chat message in a request body, or `null` when it is not a usable one. */
function parseMessage(text) {
  let body;
  try {
    body = JSON.parse(text ?? '');
  } catch {
    return null;
  }
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (message === '' || message.length > MAX_MESSAGE_CHARACTERS) {
    return null;
  }

  return message;
}

/** Write the session snapshot to the state file, so standalone Pi can follow along with no monitor. */
export async function writeStateFile(stateFile, snapshot) {
  await writeWorkspaceFile(stateFile, `${JSON.stringify(snapshot, null, 2)}\n`);
}

/**
 * Create the page server.
 *
 * @param {{ pageDir: string, configSource: { resolve: (contextKey: string) => Promise<object | null> },
 *   booker: import('./booker.mjs').Booker, session: import('./session.mjs').TravelDeskSession,
 *   sessionKey: string, stateFile: string,
 *   standIn?: import('./stand-in.mjs').LaunchDarklyStandIn }} options
 */
export function createPageServer(options) {
  let busy = false;

  /** The booker config this session gets right now. */
  const currentConfig = () => options.configSource.resolve(options.sessionKey);

  /** Answer one chat message on the config live now. */
  const chat = async (request, response) => {
    if (!isOwnPage(request)) {
      sendStatus(response, 403, 'chat messages come only from the travel desk page');

      return;
    }
    const message = parseMessage(await readBody(request, MAX_BODY_BYTES));
    if (message === null) {
      sendStatus(response, 400, `send {"message": "..."} with 1 to ${MAX_MESSAGE_CHARACTERS} characters`);

      return;
    }
    if (busy) {
      sendStatus(response, 409, 'the booker is still answering the last message');

      return;
    }

    busy = true;
    try {
      const config = await currentConfig();
      if (config === null) {
        options.session.recordFailure(null, message, 'The booker has no config from LaunchDarkly right now.');
      } else {
        try {
          const result = await options.booker.reply(config, options.session.conversationFor(config), message);
          options.session.recordExchange(config, message, result);
        } catch (error) {
          if (!(error instanceof GeminiError)) {
            throw error;
          }
          options.session.recordFailure(config, message, `The booker could not reach its model: ${error.message}.`);
        }
      }
      const snapshot = options.session.snapshot(config);
      await writeStateFile(options.stateFile, snapshot);
      sendJson(response, 200, { ...snapshot, messages: options.session.messages });
    } finally {
      busy = false;
    }
  };

  /** Serve one of the page's files. */
  const servePageFile = async (response, [fileName, contentType]) => {
    const contents = await readFile(path.join(options.pageDir, fileName));
    response.writeHead(200, { ...BASE_HEADERS, 'content-type': contentType });
    response.end(contents);
  };

  /** Answer one request: the stand-in's paths, the page's files, or the travel desk API. */
  const route = async (request, response) => {
    if (!hostIsLoopback(request)) {
      sendStatus(response, 421, 'address this server as 127.0.0.1 or localhost');

      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
    } catch {
      sendStatus(response, 400, 'malformed path');

      return;
    }

    if (options.standIn !== undefined && pathname.startsWith(`${DEMO_PATH}/`)) {
      if (!options.standIn.handle(request, response, pathname.slice(DEMO_PATH.length))) {
        sendStatus(response, 404, 'not found');
      }

      return;
    }
    if (request.method === 'GET' && PAGE_FILES[pathname] !== undefined) {
      await servePageFile(response, PAGE_FILES[pathname]);

      return;
    }
    if (request.method === 'GET' && pathname === '/api/state') {
      sendJson(response, 200, { ...options.session.snapshot(await currentConfig()), busy });

      return;
    }
    if (request.method === 'GET' && pathname === '/api/history') {
      sendJson(response, 200, { messages: options.session.messages });

      return;
    }
    if (request.method === 'POST' && pathname === '/api/chat') {
      await chat(request, response);

      return;
    }
    sendStatus(response, 404, 'not found');
  };

  return createServer((request, response) => {
    route(request, response).catch(() => {
      if (!response.headersSent) {
        sendStatus(response, 500, 'the travel desk hit an error');
      } else {
        response.end();
      }
    });
  });
}

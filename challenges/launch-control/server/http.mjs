/** Small HTTP helpers the page server and the LaunchDarkly stand-in share. */

/** Send `body` as JSON with `status`, plus any extra `headers`. */
export function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'cache-control': 'no-store', ...headers, 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

/**
 * Read a request body as UTF-8 text.
 *
 * @returns {Promise<string | null>} the body, or `null` once it passes `limit` bytes; the rest is
 *   read and dropped, so the client can finish sending and read the answer.
 */
export function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
      }
    });
    request.on('end', () => resolve(size > limit ? null : Buffer.concat(chunks).toString('utf8')));
    request.once('error', reject);
  });
}

/** Pause for `milliseconds`. */
export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

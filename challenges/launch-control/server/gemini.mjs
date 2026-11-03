/**
 * The Gemini API call the booker makes: one `generateContent` request per model turn. The key goes
 * only into the `x-goog-api-key` header of requests to the configured origin, and no error carries
 * it. On a station the request leaves through the vault proxy, which swaps the placeholder key for
 * the real one.
 */

/** How long one model turn may take. */
const REQUEST_TIMEOUT_MS = 45_000;

/** Gemini did not answer usefully. The message names the model and status, never the key. */
export class GeminiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GeminiError';
  }
}

/** Calls Gemini's REST API with an API key. */
export class GeminiClient {
  #key;

  /** @param {{ origin: string, key: string }} options */
  constructor(options) {
    this.origin = options.origin;
    this.#key = options.key;
  }

  /**
   * Run one model turn.
   *
   * @param {string} model a Gemini model name, such as `gemini-3.8-flash`.
   * @param {object} body a `generateContent` request body.
   * @returns {Promise<object>} the first candidate's `content`.
   * @throws {GeminiError} on a network failure, a timeout, a non-2xx answer, or no candidate.
   */
  async generate(model, body) {
    let response;
    try {
      response = await fetch(`${this.origin}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.#key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? 'timed out' : 'could not be reached';
      throw new GeminiError(`${model} ${reason}`);
    }

    const text = await response.text();
    if (!response.ok) {
      throw new GeminiError(`${model} answered HTTP ${response.status}`);
    }
    const content = JSON.parse(text).candidates?.[0]?.content;
    if (content === undefined) {
      throw new GeminiError(`${model} returned no answer`);
    }

    return { role: 'model', parts: content.parts ?? [] };
  }
}

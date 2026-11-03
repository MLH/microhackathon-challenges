/**
 * The travel booker's agent loop: one participant message in, one reply out. It runs on exactly
 * the config LaunchDarkly served this session, its model, its instructions, and only the tools
 * attached to it, calling the travel desk for each tool call until the model answers in text.
 */

/** The most model turns one reply may take, tool calls included. */
const MAX_MODEL_TURNS = 8;

/** The reply when the model stops calling tools without saying anything. */
const EMPTY_REPLY = '(The booker did not answer.)';

/** A one-line summary of a tool call for the chat, such as `search_flights JFK → LIS 2027-03-12`. */
export function summarizeToolCall(name, args) {
  switch (name) {
    case 'search_flights':
      return `search_flights ${args.origin ?? '?'} → ${args.destination ?? '?'} ${args.date ?? ''}`.trim();
    case 'search_hotels':
      return `search_hotels ${args.city ?? '?'} ${args.check_in ?? ''} – ${args.check_out ?? ''}`.trim();
    case 'book_trip':
      return `book_trip ${args.outbound_flight_id ?? '?'} + ${args.return_flight_id ?? '?'} + ${args.hotel_id ?? '?'}`;
    default:
      return name;
  }
}

/** The text a model turn says, leaving out its thoughts. */
function spokenText(content) {
  return content.parts
    .filter((part) => typeof part.text === 'string' && part.thought !== true)
    .map((part) => part.text)
    .join('')
    .trim();
}

/** Runs the booker's turns against Gemini and the travel desk. */
export class Booker {
  /**
   * @param {{ gemini: import('./gemini.mjs').GeminiClient,
   *   desk: import('./travel-desk.mjs').TravelDesk }} options
   */
  constructor(options) {
    this.gemini = options.gemini;
    this.desk = options.desk;
  }

  /**
   * Answer `message` on `config`, continuing `contents`, the conversation so far on this config.
   *
   * @param {ReturnType<typeof import('./booker-config.mjs').describeBookerConfig>} config
   * @param {object[]} contents Gemini contents; the new turns are appended to it.
   * @returns {Promise<{ reply: string, toolCalls: string[], booking: object | null }>}
   * @throws {import('./gemini.mjs').GeminiError} when Gemini fails.
   */
  async reply(config, contents, message) {
    contents.push({ role: 'user', parts: [{ text: message }] });
    const request = {
      systemInstruction: { parts: [{ text: config.instructions }] },
      ...(config.tools.length === 0 ? {} : { tools: [{ functionDeclarations: config.tools }] }),
    };
    const allowedTools = new Set(config.tools.map((tool) => tool.name));
    const toolCalls = [];
    let booking = null;

    for (let turn = 0; turn < MAX_MODEL_TURNS; turn += 1) {
      const content = await this.gemini.generate(config.model, { ...request, contents });
      contents.push(content);
      const calls = content.parts.filter((part) => part.functionCall !== undefined).map((part) => part.functionCall);
      if (calls.length === 0) {
        return { reply: spokenText(content) || EMPTY_REPLY, toolCalls, booking };
      }

      const responses = [];
      for (const call of calls) {
        const args = call.args ?? {};
        toolCalls.push(summarizeToolCall(call.name, args));
        const result = allowedTools.has(call.name)
          ? await this.desk.run(call.name, args)
          : { error: `The tool ${call.name} is not attached to this agent.` };
        if (call.name === 'book_trip' && result.error === undefined) {
          booking = result;
        }
        responses.push({ functionResponse: { name: call.name, ...(call.id === undefined ? {} : { id: call.id }), response: result } });
      }
      contents.push({ role: 'user', parts: responses });
    }

    return { reply: 'The booker gave up after too many steps.', toolCalls, booking };
  }
}

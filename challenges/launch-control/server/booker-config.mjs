/**
 * The booker's config for this session, as LaunchDarkly's AI SDK resolves it: the variation, model,
 * instructions, and tools the AgentControl config serves the session's context right now. A
 * streaming SDK client keeps it current, so a targeting change reaches the booker in about a
 * second with no restart. Analytics and diagnostic events stay off, so the client talks only to
 * the streaming host. The ladder only names the rung; everything the booker runs on comes from
 * what the SDK delivered.
 */
import { init } from '@launchdarkly/node-server-sdk';
import { initClient, inspectConfig, shutdown } from '@launchdarkly/ai-server';
import { rungByKey } from './ladder.mjs';

/** A logger that stays quiet: the page server's output goes nowhere, and errors surface as state. */
const QUIET_LOGGER = { debug() {}, info() {}, warn() {}, error() {} };

/** How long the client may take to receive its first data set. */
const INITIALIZATION_TIMEOUT_SECONDS = 10;

/** The longest prompt excerpt the config card shows. */
const PROMPT_EXCERPT_CHARACTERS = 160;

/** The first line or so of `instructions`, for the config card. */
function promptExcerpt(instructions) {
  const flattened = instructions.replace(/\s+/g, ' ').trim();

  return flattened.length <= PROMPT_EXCERPT_CHARACTERS
    ? flattened
    : `${flattened.slice(0, PROMPT_EXCERPT_CHARACTERS - 1).trimEnd()}…`;
}

/**
 * Reduce an `inspectConfig` result to what the booker runs on.
 *
 * @returns {{ rung: number, variationKey: string, name: string, model: string,
 *   instructions: string, promptExcerpt: string, tools: { name: string, description: string,
 *   parameters: object }[] } | null} `null` when the config is off, missing, or serves a
 *   variation the ladder does not know.
 */
export function describeBookerConfig(ladder, result) {
  const variationKey = result?.meta?.variationKey;
  const rung = rungByKey(ladder, variationKey);
  if (!result?.enabled || result.config === null || rung === undefined) {
    return null;
  }

  const instructions = result.config.instructions ?? '';
  const tools = Object.values(result.config.tools ?? {}).map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters ?? { type: 'object', properties: {} },
  }));

  return {
    rung: rung.rung,
    variationKey,
    name: rung.name,
    model: result.config.model?.name ?? '',
    instructions,
    promptExcerpt: promptExcerpt(instructions),
    tools,
  };
}

/** A streaming connection to the booker's AgentControl config. */
export class BookerConfigSource {
  #client;

  /** Use {@link BookerConfigSource.connect}. */
  constructor(client, options) {
    this.#client = client;
    this.configKey = options.configKey;
    this.ladder = options.ladder;
  }

  /**
   * Connect and wait for the first data set.
   *
   * @param {{ streamOrigin: string, sdkKey: string, configKey: string,
   *   ladder: ReturnType<typeof import('./ladder.mjs').parseLadder> }} options
   * @throws {Error} when LaunchDarkly does not deliver within the initialization timeout; the
   *   message never carries the key.
   */
  static async connect(options) {
    const client = init(options.sdkKey, {
      stream: true,
      streamUri: options.streamOrigin,
      baseUri: options.streamOrigin,
      eventsUri: options.streamOrigin,
      sendEvents: false,
      diagnosticOptOut: true,
      logger: QUIET_LOGGER,
    });
    try {
      await client.waitForInitialization({ timeout: INITIALIZATION_TIMEOUT_SECONDS });
    } catch {
      client.close();
      throw new Error(`LaunchDarkly did not deliver the booker config within ${INITIALIZATION_TIMEOUT_SECONDS} s`);
    }
    await initClient(client);

    return new BookerConfigSource(client, options);
  }

  /** The config the session `contextKey` gets now, or `null` (see {@link describeBookerConfig}). */
  async resolve(contextKey) {
    const result = await inspectConfig(this.configKey, { kind: 'user', key: contextKey });

    return describeBookerConfig(this.ladder, result);
  }

  /** Call `listener` whenever LaunchDarkly delivers a change to the booker config. */
  onChange(listener) {
    this.#client.on(`update:${this.configKey}`, listener);
  }

  /** Close the connection. */
  async close() {
    await shutdown();
    this.#client.close();
  }
}

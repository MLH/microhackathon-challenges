/**
 * The package's MCP server, `travel-desk`: one tool, `switch_travel_agent`, over stdio JSON-RPC
 * (one message per line). It reads the attempt's runtime config from the workspace and the
 * LaunchDarkly API token from its environment, which it passes only to the REST client and never
 * prints. In demo mode the token is unused and the calls go to the page server's stand-in.
 */
import { createInterface } from 'node:readline';
import { LaunchDarklyApi, LaunchDarklyApiError } from '../server/launchdarkly-api.mjs';
import { loadLadder } from '../server/ladder.mjs';
import { PACKAGE_DIR, resolveStatePaths } from '../server/paths.mjs';
import { readRuntimeConfig } from '../server/runtime-config.mjs';
import { API_TOKEN_VARIABLE } from '../server/settings.mjs';
import { SwitchRefusedError, switchTravelAgent } from './switch.mjs';

/** The MCP protocol version this server speaks when the client names none. */
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/** The ladder the tool climbs. */
const LADDER = loadLadder(PACKAGE_DIR);

/** The tool's definition, as `tools/list` returns it, with each rung's addition from the ladder. */
const SWITCH_TOOL = {
  name: 'switch_travel_agent',
  description: [
    "Switch this session's travel booker to another rung of its LaunchDarkly AgentControl config, with no restart or deploy.",
    'Accepts only the next rung, or 1 to roll back.',
    ...LADDER.rungs.map((rung) => `Rung ${rung.rung} (${rung.name}): ${rung.adds}`),
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: { rung: { type: 'integer', minimum: 1, maximum: LADDER.rungs.length, description: 'The rung to switch to.' } },
    required: ['rung'],
    additionalProperties: false,
  },
};

/** Write one JSON-RPC message. */
function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

/** A tool result holding `text`, marked as an error when `isError`. */
function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/** Run `switch_travel_agent` for this workspace. */
async function callSwitch(args) {
  // pi-mcp-adapter starts this server in the package directory, not Pi's, but passes Pi's
  // environment, so standalone, Pi's working directory arrives only as PWD.
  const paths = resolveStatePaths(process.env, process.env.PWD ?? process.cwd());
  const runtimeConfig = await readRuntimeConfig(paths.runtimeConfigFile);
  if (runtimeConfig === null) {
    return toolResult('Launch Control is not set up in this workspace. Run the package setup hook first.', true);
  }

  const { launchDarkly } = runtimeConfig;
  const api = new LaunchDarklyApi({
    origin: launchDarkly.apiOrigin,
    token: runtimeConfig.mode === 'live' ? (process.env[API_TOKEN_VARIABLE] ?? '') : 'demo',
    projectKey: launchDarkly.projectKey,
    environmentKey: launchDarkly.environmentKey,
    configKey: launchDarkly.configKey,
  });
  try {
    const text = await switchTravelAgent(
      { ladder: LADDER, api, sessionKey: runtimeConfig.sessionKey, pagePort: runtimeConfig.pagePort },
      args?.rung,
    );

    return toolResult(text);
  } catch (error) {
    if (error instanceof SwitchRefusedError || error instanceof LaunchDarklyApiError) {
      return toolResult(error.message, true);
    }
    throw error;
  }
}

/** Answer one JSON-RPC request; notifications get no answer. */
async function handle(message) {
  const { id, method, params } = message;
  /** Answer the request with `result`; a notification has no id and gets no answer. */
  const reply = (result) => id !== undefined && send({ id, result });
  switch (method) {
    case 'initialize':
      reply({
        protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'travel-desk', version: '1.0.0' },
      });
      break;
    case 'ping':
      reply({});
      break;
    case 'tools/list':
      reply({ tools: [SWITCH_TOOL] });
      break;
    case 'tools/call':
      if (params?.name !== SWITCH_TOOL.name) {
        reply(toolResult(`There is no tool named ${params?.name}.`, true));
        break;
      }
      reply(await callSwitch(params.arguments));
      break;
    default:
      if (id !== undefined) {
        send({ id, error: { code: -32601, message: `method not found: ${method}` } });
      }
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (line.trim() === '') {
    return;
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: 'parse error' } });

    return;
  }
  handle(message).catch(() => {
    if (message.id !== undefined) {
      send({ id: message.id, error: { code: -32603, message: 'the travel desk tool hit an error' } });
    }
  });
});

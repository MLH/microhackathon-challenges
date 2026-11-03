#!/usr/bin/env node
/**
 * Provision the travel booker's AgentControl config in a LaunchDarkly project from `ladder.json`:
 * the three tools, the agent-mode config, its four variations, and a default rule serving v1. A
 * human runs it once per LaunchDarkly project, with an access token that can write AI Configs.
 * It is idempotent: a second run updates what changed and creates nothing twice.
 *
 * Usage: LAUNCHDARKLY_API_AUTH_TOKEN=api-… node provision.mjs, with the project, environment, and
 * config keys in `launchdarkly.json` or LAUNCHDARKLY_PROJECT_KEY, LAUNCHDARKLY_ENVIRONMENT_KEY, and
 * LAUNCHDARKLY_AI_CONFIG_KEY.
 */
import { loadLadder, modelConfigKey, rungByNumber } from './server/ladder.mjs';
import { PACKAGE_DIR } from './server/paths.mjs';
import { LaunchDarklyApiError, requestLaunchDarkly, SEMANTIC_PATCH_TYPE } from './server/launchdarkly-api.mjs';
import { API_TOKEN_VARIABLE, launchDarklyOrigins, readSettings } from './server/settings.mjs';

/** The config's display name in LaunchDarkly. */
const CONFIG_NAME = 'Launch Control travel booker';

/**
 * Call the LaunchDarkly REST API, rate limits waited out.
 *
 * @returns {Promise<object | null>} the JSON answer, `{}` for an empty one, or `null` for a 404.
 * @throws {LaunchDarklyApiError} naming the request and LaunchDarkly's message for any other failure.
 */
async function rest(connection, method, path, body, contentType) {
  try {
    return (await requestLaunchDarkly(connection, { method, path: `/api/v2${path}`, body, contentType })) ?? {};
  } catch (error) {
    if (error instanceof LaunchDarklyApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/** `value` as JSON with every object's keys sorted, so equal schemas compare equal. */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);

    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(value);
}

/** Create or update each ladder tool, returning each tool's current version. */
async function provisionTools(connection, project, ladder) {
  const versions = new Map();
  for (const [key, tool] of Object.entries(ladder.tools)) {
    const path = `/projects/${project}/ai-tools/${key}`;
    const existing = await rest(connection, 'GET', path);
    let saved;
    if (existing === null) {
      saved = await rest(connection, 'POST', `/projects/${project}/ai-tools`, { key, description: tool.description, schema: tool.parameters });
      console.log(`created tool ${key}`);
    } else if (existing.description !== tool.description || canonicalJson(existing.schema) !== canonicalJson(tool.parameters)) {
      saved = await rest(connection, 'PATCH', path, { description: tool.description, schema: tool.parameters });
      console.log(`updated tool ${key}`);
    } else {
      saved = existing;
      console.log(`tool ${key} is current`);
    }
    versions.set(key, saved.version ?? existing?.version ?? 1);
  }

  return versions;
}

/** Create the agent-mode config if it is missing, and return it. */
async function provisionConfig(connection, project, configKey) {
  const path = `/projects/${project}/ai-configs/${configKey}`;
  const existing = await rest(connection, 'GET', path);
  if (existing !== null) {
    if (existing.mode !== 'agent') {
      throw new Error(`${configKey} exists in ${existing.mode} mode; the booker needs an agent-mode config`);
    }
    console.log(`config ${configKey} exists`);

    return existing;
  }

  await rest(connection, 'POST', `/projects/${project}/ai-configs`, { key: configKey, name: CONFIG_NAME, mode: 'agent' });
  console.log(`created config ${configKey}`);

  return rest(connection, 'GET', path);
}

/** Create or update each rung's variation. */
async function provisionVariations(connection, project, configKey, ladder, config, toolVersions) {
  const existingKeys = new Set((config.variations ?? []).map((variation) => variation.key));
  for (const rung of ladder.rungs) {
    const body = {
      name: rung.key,
      instructions: rung.instructions,
      modelConfigKey: modelConfigKey(ladder, rung),
      model: { modelName: rung.model, parameters: {} },
      tools: rung.tools.map((key) => ({ key, version: toolVersions.get(key) })),
    };
    if (existingKeys.has(rung.key)) {
      await rest(connection, 'PATCH', `/projects/${project}/ai-configs/${configKey}/variations/${rung.key}`, body);
      console.log(`updated variation ${rung.key}`);
    } else {
      await rest(connection, 'POST', `/projects/${project}/ai-configs/${configKey}/variations`, { key: rung.key, ...body });
      console.log(`created variation ${rung.key}`);
    }
  }
}

/** Serve v1 by default in the environment, so every session starts on the bottom rung. */
async function provisionDefaultRule(connection, project, environment, configKey, ladder) {
  const targeting = await rest(connection, 'GET', `/projects/${project}/ai-configs/${configKey}/targeting`);
  const first = rungByNumber(ladder, 1);
  const variation = targeting.variations.find((candidate) => (candidate.key ?? candidate.name) === first.key);
  await rest(
    connection,
    'PATCH',
    `/projects/${project}/ai-configs/${configKey}/targeting`,
    {
      environmentKey: environment,
      comment: 'Launch Control: serve v1 by default',
      instructions: [{ kind: 'updateFallthroughVariationOrRollout', variationId: variation._id }],
    },
    SEMANTIC_PATCH_TYPE,
  );
  console.log(`default rule in ${environment} serves ${first.key}`);
}

/** Provision everything. */
async function main() {
  const token = process.env[API_TOKEN_VARIABLE] ?? '';
  if (token === '') {
    throw new Error(`${API_TOKEN_VARIABLE} is not set`);
  }
  const settings = await readSettings(process.env, PACKAGE_DIR);
  if (settings === null) {
    throw new Error('fill in launchdarkly.json, or set LAUNCHDARKLY_PROJECT_KEY, LAUNCHDARKLY_ENVIRONMENT_KEY, and LAUNCHDARKLY_AI_CONFIG_KEY');
  }
  const { projectKey, environmentKey, configKey } = settings;
  const ladder = loadLadder(PACKAGE_DIR);
  const connection = { origin: launchDarklyOrigins('live', 0, process.env).api, token };

  const toolVersions = await provisionTools(connection, projectKey, ladder);
  const config = await provisionConfig(connection, projectKey, configKey);
  await provisionVariations(connection, projectKey, configKey, ladder, config, toolVersions);
  await provisionDefaultRule(connection, projectKey, environmentKey, configKey, ladder);
  console.log(`provisioned ${configKey} in ${projectKey}/${environmentKey}`);
}

main().catch((error) => {
  console.error(`provision: ${error.message}`);
  process.exit(1);
});

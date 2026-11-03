/**
 * The attempt's runtime config: what setup decided, written to the workspace for the page server
 * and the MCP tool to read. It holds the mode, the session's context key, the page port, and the
 * public LaunchDarkly settings and origins. It never holds a key.
 */
import { readWorkspaceFile } from './workspace-file.mjs';

/** The most a runtime config file holds. */
const MAX_RUNTIME_CONFIG_BYTES = 4 * 1024;

/** Throw a validation error naming the field. */
function invalid(field) {
  throw new Error(`the runtime config's ${field} is missing or malformed`);
}

/** Require `record[field]` to be a non-empty string. */
function requireString(record, field, label = field) {
  if (typeof record?.[field] !== 'string' || record[field] === '') {
    invalid(label);
  }

  return record[field];
}

/**
 * Parse a runtime config record.
 *
 * @returns {{ attemptId: string, sessionKey: string, mode: 'live' | 'demo', pagePort: number,
 *   launchDarkly: { apiOrigin: string, streamOrigin: string, projectKey: string,
 *   environmentKey: string, configKey: string } }}
 * @throws {Error} naming the first malformed field.
 */
export function parseRuntimeConfig(record) {
  const mode = record?.mode;
  if (mode !== 'live' && mode !== 'demo') {
    invalid('mode');
  }
  if (!Number.isInteger(record.pagePort) || record.pagePort < 1 || record.pagePort > 65_535) {
    invalid('pagePort');
  }
  const launchDarkly = record.launchDarkly;

  return {
    attemptId: requireString(record, 'attemptId'),
    sessionKey: requireString(record, 'sessionKey'),
    mode,
    pagePort: record.pagePort,
    launchDarkly: {
      apiOrigin: requireString(launchDarkly, 'apiOrigin', 'launchDarkly.apiOrigin'),
      streamOrigin: requireString(launchDarkly, 'streamOrigin', 'launchDarkly.streamOrigin'),
      projectKey: requireString(launchDarkly, 'projectKey', 'launchDarkly.projectKey'),
      environmentKey: requireString(launchDarkly, 'environmentKey', 'launchDarkly.environmentKey'),
      configKey: requireString(launchDarkly, 'configKey', 'launchDarkly.configKey'),
    },
  };
}

/**
 * Read the attempt's runtime config from `file`.
 *
 * @returns {Promise<ReturnType<typeof parseRuntimeConfig> | null>} `null` when there is none.
 * @throws {Error} when the file is not JSON or is malformed.
 */
export async function readRuntimeConfig(file) {
  const text = await readWorkspaceFile(file, MAX_RUNTIME_CONFIG_BYTES);
  if (text === null) {
    return null;
  }

  return parseRuntimeConfig(JSON.parse(text));
}

/**
 * The ladder: the four variations of the travel booker's AgentControl config, read from
 * `ladder.json`. `provision.mjs` writes them to LaunchDarkly and demo mode's stand-in serves them,
 * so this module is the one reader of that file and the one place that knows the variation shape
 * LaunchDarkly's SDK delivers.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The package file holding the ladder. */
export const LADDER_FILE_NAME = 'ladder.json';

/** Throw a validation error naming the ladder file. */
function invalid(message) {
  throw new Error(`${LADDER_FILE_NAME}: ${message}`);
}

/** Validate one rung against the ladder's tools and its place in the order. */
function parseRung(record, index, toolNames) {
  const expected = index + 1;
  if (record?.rung !== expected) {
    invalid(`rung ${expected} is missing or out of order`);
  }
  for (const field of ['key', 'name', 'adds', 'model', 'instructions']) {
    if (typeof record[field] !== 'string' || record[field] === '') {
      invalid(`rung ${expected} needs a ${field}`);
    }
  }
  if (!Array.isArray(record.tools) || record.tools.some((tool) => !toolNames.includes(tool))) {
    invalid(`rung ${expected} lists a tool the ladder does not define`);
  }

  return {
    rung: record.rung,
    key: record.key,
    name: record.name,
    adds: record.adds,
    model: record.model,
    instructions: record.instructions,
    tools: [...record.tools],
  };
}

/**
 * Parse the ladder's record.
 *
 * @returns {{ provider: string, tools: Record<string, { description: string,
 *   parameters: object }>, rungs: ReturnType<typeof parseRung>[] }}
 * @throws {Error} naming the first rule the record breaks.
 */
export function parseLadder(record) {
  if (typeof record?.provider !== 'string' || typeof record.tools !== 'object') {
    invalid('needs a provider and tools');
  }
  const toolNames = Object.keys(record.tools);
  if (!Array.isArray(record.rungs) || record.rungs.length === 0) {
    invalid('needs rungs');
  }
  const rungs = record.rungs.map((rung, index) => parseRung(rung, index, toolNames));
  if (new Set(rungs.map((rung) => rung.key)).size !== rungs.length) {
    invalid('two rungs share a key');
  }

  return { provider: record.provider, tools: record.tools, rungs };
}

/** Read and parse the package's ladder. */
export function loadLadder(packageDir) {
  return parseLadder(JSON.parse(readFileSync(path.join(packageDir, LADDER_FILE_NAME), 'utf8')));
}

/** The rung serving variation `variationKey`, or `undefined` for one the ladder does not know. */
export function rungByKey(ladder, variationKey) {
  return ladder.rungs.find((rung) => rung.key === variationKey);
}

/** The rung numbered `number`, or `undefined` past either end of the ladder. */
export function rungByNumber(ladder, number) {
  return ladder.rungs.find((rung) => rung.rung === number);
}

/** LaunchDarkly's model config key for a rung's model, such as `Gemini.gemini-3.8-flash`. */
export function modelConfigKey(ladder, rung) {
  return `${ladder.provider}.${rung.model}`;
}

/** A rung's tools as function declarations: name, description, and parameter schema. */
export function toolDeclarations(ladder, rung) {
  return rung.tools.map((name) => ({ name, ...ladder.tools[name] }));
}

/**
 * The variation value LaunchDarkly's SDK delivers for a rung of an agent-mode config, which the
 * demo stand-in serves in its place.
 */
export function variationValue(ladder, rung) {
  const tools = Object.fromEntries(
    toolDeclarations(ladder, rung).map((tool) => [tool.name, { type: 'function', ...tool }]),
  );

  return {
    _ldMeta: {
      enabled: true,
      mode: 'agent',
      variationKey: rung.key,
      version: 1,
      modelKey: modelConfigKey(ladder, rung),
    },
    instructions: rung.instructions,
    model: { name: rung.model, parameters: {} },
    provider: { name: ladder.provider },
    ...(rung.tools.length === 0 ? {} : { tools }),
  };
}

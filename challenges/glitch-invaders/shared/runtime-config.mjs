/**
 * The attempt's runtime config: setup writes it, the page server serves it as
 * `/runtime-config.json`, and the page reads it to tie saved progress to this attempt.
 */

/** Thrown when a served or stored runtime config is malformed. */
export class InvalidRuntimeConfigError extends Error {
  constructor(reason) {
    super(`invalid runtime config: ${reason}`);
    this.name = 'InvalidRuntimeConfigError';
  }
}

/**
 * Validate untrusted JSON as a runtime config.
 *
 * @returns {{ attemptId: string }}
 * @throws {InvalidRuntimeConfigError} when it is not an object or `attemptId` is malformed.
 */
export function parseRuntimeConfig(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidRuntimeConfigError('config must be an object');
  }

  const { attemptId } = value;
  if (typeof attemptId !== 'string' || !/^[a-z0-9-]{4,64}$/.test(attemptId)) {
    throw new InvalidRuntimeConfigError(
      'attemptId must be 4 to 64 lowercase letters, digits, or hyphens',
    );
  }

  return { attemptId };
}

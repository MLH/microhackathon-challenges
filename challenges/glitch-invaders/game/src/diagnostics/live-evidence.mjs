/**
 * Live-mode evidence: report the failure to Sentry, then ask the page server for what Sentry
 * recorded. When either step fails, the console still gets the simulated evidence, labelled with
 * why, so it is never left blank.
 */

/** How long the page waits for the server, which gives up on Sentry sooner than this. */
const EVIDENCE_TIMEOUT_MS = 20_000;

/** The notes a fallback carries, by what went wrong. */
export const FALLBACK_NOTES = {
  unsent: 'Sentry did not accept the report, so this is simulated evidence.',
  unavailable: 'Sentry could not return the report in time, so this is simulated evidence.',
  restored: 'The page reloaded after this report, so this is simulated evidence.',
};

/** Builds evidence from Sentry's own record of each report. */
export class LiveEvidenceProvider {
  /**
   * @param {{ reporter: { report: Function }, simulated: { evidenceFor: Function },
   *   fetchImpl: typeof fetch }} options `fetchImpl` reaches the page server.
   */
  constructor(options) {
    this.options = options;
  }

  /** Report `encounter` and fetch Sentry's evidence for it. Never rejects. */
  async evidenceFor(encounter) {
    const outcome = await this.options.reporter.report(encounter);
    if (!outcome.delivered) {
      return this.fallback(encounter, 'unsent');
    }

    try {
      const query = new URLSearchParams({ bug: encounter.bug, id: outcome.id });
      const response = await this.options.fetchImpl(`/api/sentry-evidence?${query}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(EVIDENCE_TIMEOUT_MS),
      });
      if (!response.ok) {
        return this.fallback(encounter, 'unavailable');
      }

      return await response.json();
    } catch {
      return this.fallback(encounter, 'unavailable');
    }
  }

  /** The simulated evidence for `encounter`, labelled as a fallback with the note for `reason`. */
  async fallback(encounter, reason) {
    const simulated = await this.options.simulated.evidenceFor(encounter);

    return { ...simulated, source: 'fallback', note: FALLBACK_NOTES[reason] };
  }
}

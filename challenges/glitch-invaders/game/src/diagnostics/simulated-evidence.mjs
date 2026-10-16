/**
 * Demo-mode evidence: realistic and deterministic, built without any Sentry credentials. It is
 * clearly labelled simulated, and carries the same decisions as the live evidence.
 */

import {
  evidenceSections,
  evidenceTitle,
  SEQUENTIAL_BOSS_SPANS,
  SIMULATED_SHIELD_BREADCRUMBS,
  simulatedReference,
} from './evidence-builders.mjs';

/** Produces fixed evidence, whatever the run measured. */
export class SimulatedEvidenceProvider {
  /** Evidence for `encounter`, labelled simulated and with no Sentry link. */
  async evidenceFor(encounter) {
    return {
      bug: encounter.bug,
      source: 'simulated',
      title: evidenceTitle(encounter),
      referenceId: simulatedReference(encounter.bug),
      sections: evidenceSections(encounter, SIMULATED_SHIELD_BREADCRUMBS, SEQUENTIAL_BOSS_SPANS),
      link: null,
    };
  }
}

import { issueSearchUrl, traceUrl } from '../sentry/links.mjs';

import { toBreadcrumbEntries } from './breadcrumbs.mjs';

import { evidenceSections, evidenceTitle } from './evidence-builders.mjs';

/** How many of the most recent breadcrumbs the console shows. */
const SHOWN_BREADCRUMBS = 8;

/** Reports each encounter to Sentry and shows the local capture of what was sent. */
export class LiveEvidenceProvider {
  options;

  constructor(options) {
    this.options = options;
  }

  /** Report `encounter`, then build evidence from the local capture. Never rejects. */
  async evidenceFor(encounter) {
    const { recorder, clock } = this.options;
    const entries = toBreadcrumbEntries(recorder.trail(), clock(), SHOWN_BREADCRUMBS);
    const spans = encounter.bug === 'boss' ? encounter.stall.spans : [];
    const outcome = await this.report(encounter);

    return {
      bug: encounter.bug,
      source: outcome.delivery === 'confirmed' ? 'live' : 'live-unconfirmed',
      title: evidenceTitle(encounter),
      referenceId: outcome.referenceId,
      sections: evidenceSections(encounter, entries, spans),
      link: this.linkFor(encounter, outcome),
    };
  }

  /** Report to Sentry, degrading to an unconfirmed outcome if reporting itself fails. */
  async report(encounter) {
    try {
      return await this.options.reporter.report(encounter);
    } catch {
      return { referenceId: 'not-sent', delivery: 'unconfirmed' };
    }
  }

  /** The Sentry page for this failure, when there is something to link to. */
  linkFor(encounter, outcome) {
    const { settings, attemptId } = this.options;
    if (encounter.bug === 'boss') {
      const traceId = encounter.stall.traceId;

      return traceId === null
        ? null
        : { label: 'Investigate trace in Sentry', url: traceUrl(settings, traceId) };
    }
    if (outcome.referenceId === 'not-sent') {
      return null;
    }

    return {
      label: 'Investigate in Sentry',
      url: issueSearchUrl(settings, attemptId, encounter.bug),
    };
  }
}

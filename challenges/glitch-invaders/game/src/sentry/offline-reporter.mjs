/** The reporter demo mode uses: it sends nothing anywhere. */
import { runWithoutSpans } from '../boss/boss-loader.mjs';

/** Reports to no one, so demo mode needs no credentials and makes no network requests. */
export class OfflineReporter {
  /** Breadcrumbs are kept by the local recorder alone. */
  add() {}

  /** Run `work` with no tracing. */
  async traceBossSpawn(work) {
    return { result: await work(runWithoutSpans), traceId: null };
  }

  /** There is nothing to deliver, so nothing is confirmed. */
  async report() {
    return { referenceId: 'offline', delivery: 'unconfirmed' };
  }
}

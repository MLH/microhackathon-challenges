/** Where a run's progress is kept so a refresh or an agent restart can pick up where it left off. */
import { parseProgress } from '../../../shared/progress.mjs';

/** Keeps progress on the page server, which writes it into the participant's workspace. */
export class HttpProgressStore {
  endpoint;
  fetchImpl;
  onError;
  pending = Promise.resolve();

  constructor(endpoint, fetchImpl, onError) {
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.onError = onError;
  }

  async load(attemptId) {
    const response = await this.fetchImpl(this.endpoint);
    if (response.status === 204 || response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`progress load failed with status ${response.status}`);
    }

    const progress = parseProgress(await response.json());

    return progress.attemptId === attemptId ? progress : null;
  }

  /** Queue the write behind earlier ones, so the last state always wins. */
  save(progress) {
    const body = JSON.stringify(progress);
    this.pending = this.pending.then(async () => {
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body,
        });
        if (!response.ok) {
          throw new Error(`progress save failed with status ${response.status}`);
        }
      } catch (error) {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return this.pending;
  }

  /** Delete the stored progress once earlier writes have landed. */
  clear() {
    this.pending = this.pending.then(async () => {
      try {
        await this.fetchImpl(this.endpoint, { method: 'DELETE' });
      } catch (error) {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return this.pending;
  }
}

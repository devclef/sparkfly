import type { Logger } from 'pino';

/**
 * Minimal SparkyFitness REST client.
 *
 *  - log a saved meal:  POST /api/food-entry-meals
 *      { meal_template_id, meal_type, entry_date, entry_time?, quantity, unit, notes? }
 *    (omitting `foods` makes SparkyFitness expand the meal template)
 *  - log a single food: POST /api/food-entries
 *      { food_id, variant_id?, meal_type, quantity, unit, entry_date, entry_time?,
 *        notes?, source, source_id }
 *    (user_id, source, source_id) is an idempotent upsert key, so resends with
 *    source "firefly" + source_id <journal id> update instead of duplicate.
 *  - update a meal:     PUT  /api/food-entry-meals/:id (meals have no upsert
 *    key, so date/time/quantity changes must be applied with an explicit PUT)
 *  - undo:              DELETE /api/food-entry-meals/:id | /api/food-entries/:id
 *
 * Food *updates* do not use PUT: re-POSTing /api/food-entries with the same
 * (source, source_id) is the documented idempotent upsert, which also
 * recreates the entry if it was deleted on the SparkyFitness side.
 */

export class SparkyError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(status > 0 ? `SparkyFitness API ${status}: ${trim(body)}` : `SparkyFitness request failed: ${trim(body)}`);
    this.name = 'SparkyError';
  }
}

const trim = (s: string): string => s.trim().slice(0, 300);

export interface LogMealRequest {
  meal_template_id: string;
  meal_type?: string;
  entry_date: string;
  entry_time?: string;
  quantity: number;
  unit?: string;
  notes?: string;
}

export interface LogFoodRequest {
  food_id: string;
  variant_id?: string;
  meal_type?: string;
  entry_date: string;
  entry_time?: string;
  quantity: number;
  unit?: string;
  notes?: string;
  source: string;
  source_id: string;
}

export interface UpdateMealRequest {
  meal_type?: string;
  entry_date: string;
  entry_time?: string;
  quantity: number;
  unit?: string;
  notes?: string;
}

export interface SparkyEntryRef {
  /** null when the API answered 2xx without a recognizable id. */
  id: string | null;
  raw: unknown;
}

export class SparkyClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: {
      baseUrl: string;
      apiKey: string;
      timeoutMs: number;
      logger: Logger;
    },
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  logMeal(body: LogMealRequest): Promise<SparkyEntryRef> {
    return this.post('/api/food-entry-meals', body);
  }

  logFood(body: LogFoodRequest): Promise<SparkyEntryRef> {
    return this.post('/api/food-entries', body);
  }

  /**
   * Update an existing meal entry in place. Throws SparkyError(404) when the
   * entry no longer exists on the SparkyFitness side — callers are expected
   * to fall back to creating a new entry in that case.
   */
  async updateMeal(id: string, body: UpdateMealRequest): Promise<void> {
    await this.request('PUT', `/api/food-entry-meals/${encodeURIComponent(id)}`, body);
  }

  // ------------------------------------------------------------------ //
  // Lookups used by the rule editor's typeaheads. Responses are passed
  // through as-is (the UI normalises them defensively).
  // ------------------------------------------------------------------ //

  mealTypes(): Promise<unknown> {
    return this.request('GET', '/api/meal-types');
  }

  /** Full meal list (used when the typeahead search term is empty). */
  listMeals(): Promise<unknown> {
    return this.request('GET', '/api/meals');
  }

  searchMeals(term: string): Promise<unknown> {
    return this.request('GET', `/api/meals/search?searchTerm=${encodeURIComponent(term)}`);
  }

  searchFoods(term: string): Promise<unknown> {
    return this.request('GET', `/api/foods/search?searchTerm=${encodeURIComponent(term)}`);
  }

  async deleteMeal(id: string): Promise<void> {
    await this.request('DELETE', `/api/food-entry-meals/${encodeURIComponent(id)}`);
  }

  async deleteFood(id: string): Promise<void> {
    await this.request('DELETE', `/api/food-entries/${encodeURIComponent(id)}`);
  }

  private async post(urlPath: string, body: object): Promise<SparkyEntryRef> {
    const res = await this.request('POST', urlPath, body);
    return { id: pickEntryId(res), raw: res };
  }

  private async request(method: string, urlPath: string, body?: unknown): Promise<unknown> {
    const url = `${this.opts.baseUrl}${urlPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        this.opts.logger.error({ url, status: res.status, body: trim(text) }, 'SparkyFitness request failed');
        throw new SparkyError(res.status, text);
      }
      if (text.trim() === '') return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    } catch (err) {
      if (err instanceof SparkyError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        this.opts.logger.error({ url, timeoutMs: this.opts.timeoutMs }, 'SparkyFitness request timed out');
        throw new SparkyError(0, `timeout after ${this.opts.timeoutMs}ms`);
      }
      this.opts.logger.error({ url, err }, 'SparkyFitness request error (network?)');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Best-effort extraction of the created entry id from an API response. */
export function pickEntryId(res: unknown): string | null {
  const dig = (o: unknown): string | null => {
    if (o === null || typeof o !== 'object') return null;
    const rec = o as Record<string, unknown>;
    for (const key of ['id', 'entryId', 'entry_id']) {
      const v = rec[key];
      if (typeof v === 'string' || typeof v === 'number') return String(v);
    }
    const nested = rec['data'] ?? rec['entry'];
    if (nested && typeof nested === 'object') return dig(nested);
    return null;
  };
  return dig(res);
}

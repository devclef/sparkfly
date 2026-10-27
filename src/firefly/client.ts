import type { Logger } from 'pino';
import { fireflySplitSchema, type FireflySplit } from './types.js';

/**
 * Minimal Firefly III API client (needs FIREFLY_URL + FIREFLY_PAT).
 *
 *  - transactions: GET /api/v1/transactions?start=&end=&page=   (backfill)
 *  - webhooks:     GET /api/v1/webhooks, POST /api/v1/webhooks (auto-registration)
 *
 * The API returns JSON:API documents; transaction groups carry the same
 * split fields as the webhook payload under `attributes.transactions`.
 */

export class FireflyError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(status > 0 ? `Firefly API ${status}: ${trim(body)}` : `Firefly request failed: ${trim(body)}`);
    this.name = 'FireflyError';
  }
}

const trim = (s: string): string => s.trim().slice(0, 300);

/** One transaction group from the API, already validated split by split. */
export interface FireflyGroup {
  id: string;
  groupTitle: string | null;
  splits: FireflySplit[];
  /** Splits that did not validate (missing fields, unknown type, …). */
  invalid: number;
}

export interface FireflyWebhook {
  id: string;
  title: string;
  url: string;
  active: boolean;
  triggers: string[];
  response: string;
  delivery: string;
}

export interface RegisterWebhookResult {
  webhook: FireflyWebhook;
  /** The signing secret Firefly generated, when the response includes it. */
  secret: string | null;
}

/** Triggers Sparkfly needs; registration asks for all three. */
export const WEBHOOK_TRIGGERS = ['STORE_TRANSACTION', 'UPDATE_TRANSACTION', 'DESTROY_TRANSACTION'] as const;

type Json = Record<string, unknown>;

const asObj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const asStr = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/** Firefly < 6.3 has single `trigger`/`response`/`delivery`; newer versions use arrays. */
function listOf(attrs: Json, plural: string, singular: string): string[] {
  const many = attrs[plural];
  if (Array.isArray(many)) return many.map(asStr).filter(Boolean);
  const one = asStr(attrs[singular]);
  return one ? [one] : [];
}

export function webhookFromApi(item: unknown): FireflyWebhook {
  const o = asObj(item);
  const a = asObj(o.attributes);
  return {
    id: asStr(o.id),
    title: asStr(a.title),
    url: asStr(a.url),
    active: a.active !== false,
    triggers: listOf(a, 'triggers', 'trigger'),
    response: listOf(a, 'responses', 'response').join(', '),
    delivery: listOf(a, 'deliveries', 'delivery').join(', '),
  };
}

export function groupFromApi(item: unknown): FireflyGroup {
  const o = asObj(item);
  const a = asObj(o.attributes);
  const raw = Array.isArray(a.transactions) ? a.transactions : [];
  const splits: FireflySplit[] = [];
  let invalid = 0;
  for (const s of raw) {
    const parsed = fireflySplitSchema.safeParse(s);
    if (parsed.success) splits.push(parsed.data);
    else invalid += 1;
  }
  return {
    id: asStr(o.id),
    groupTitle: typeof a.group_title === 'string' ? a.group_title : null,
    splits,
    invalid,
  };
}

export class FireflyClient {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: { baseUrl: string; pat: string; timeoutMs: number; logger: Logger },
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /**
   * One page of transaction groups between two dates (inclusive,
   * YYYY-MM-DD). `totalPages` comes from the JSON:API pagination meta.
   */
  async transactionsPage(
    start: string,
    end: string,
    page: number,
  ): Promise<{ groups: FireflyGroup[]; page: number; totalPages: number; total: number }> {
    const q = new URLSearchParams({ start, end, page: String(page), limit: '100' });
    const res = asObj(await this.request('GET', `/api/v1/transactions?${q.toString()}`));
    const data = Array.isArray(res.data) ? res.data : [];
    const pagination = asObj(asObj(res.meta).pagination);
    const totalPages = Number(pagination.total_pages ?? 1) || 1;
    const total = Number(pagination.total ?? data.length) || data.length;
    return { groups: data.map(groupFromApi), page, totalPages, total };
  }

  async listWebhooks(): Promise<FireflyWebhook[]> {
    const res = asObj(await this.request('GET', '/api/v1/webhooks?limit=100'));
    return (Array.isArray(res.data) ? res.data : []).map(webhookFromApi);
  }

  /**
   * Create a webhook pointing at Sparkfly. Both the current array fields
   * (`triggers`, `responses`, `deliveries`) and the older single-value
   * fields are sent, so this works across Firefly 6.x releases (older ones
   * only take the first trigger).
   */
  async registerWebhook(opts: { title: string; url: string }): Promise<RegisterWebhookResult> {
    const body = {
      title: opts.title,
      url: opts.url,
      active: true,
      triggers: [...WEBHOOK_TRIGGERS],
      responses: ['TRANSACTIONS'],
      deliveries: ['JSON'],
      trigger: WEBHOOK_TRIGGERS[0],
      response: 'TRANSACTIONS',
      delivery: 'JSON',
    };
    const res = asObj(await this.request('POST', '/api/v1/webhooks', body));
    const data = asObj(res.data);
    const secret = asStr(asObj(data.attributes).secret) || null;
    return { webhook: webhookFromApi(data), secret };
  }

  private async request(method: string, urlPath: string, body?: unknown): Promise<unknown> {
    const url = `${this.opts.baseUrl}${urlPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/vnd.api+json',
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.pat}`,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        this.opts.logger.error({ url, status: res.status, body: trim(text) }, 'Firefly request failed');
        throw new FireflyError(res.status, text);
      }
      if (text.trim() === '') return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new FireflyError(res.status, `expected JSON, got: ${text}`);
      }
    } catch (err) {
      if (err instanceof FireflyError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new FireflyError(0, `timeout after ${this.opts.timeoutMs}ms`);
      }
      throw new FireflyError(0, err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

import type { Logger } from 'pino';
import type { AppConfig } from '../config.js';
import { APP_NAME } from '../constants.js';

/**
 * Failure notifications (NOTIFY_URL). Sparkfly reports:
 *
 *  - dead:       an event used up its retry budget and needs a manual retry;
 *  - needs-rule: a new transaction the dashboard shows matched no rule
 *                (opt-in via NOTIFY_ON, since it can be chatty).
 *
 * Formats:
 *  - json: POST a JSON body. It carries `text` (Slack, Mattermost, Gotify
 *          via a proxy, …) and `content` (Discord) next to structured fields,
 *          so most chat webhooks work without a template.
 *  - ntfy: POST the message as plain text with Title/Tags/Click headers,
 *          the way ntfy.sh topics expect it.
 *
 * Sending never throws: a broken notification target must not affect
 * webhook processing, so failures are only logged.
 */

export type NotifyKind = 'dead' | 'needs-rule' | 'test';

export interface Notification {
  kind: NotifyKind;
  title: string;
  message: string;
  eventId?: number;
}

export interface NotifyResult {
  ok: boolean;
  error?: string;
}

export class Notifier {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: {
      cfg: Pick<AppConfig, 'notify' | 'publicUrl'>;
      logger: Logger;
      timeoutMs?: number;
    },
    fetchImpl?: typeof fetch,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.opts.cfg.notify.url);
  }

  /** Whether notifications of this kind are turned on (tests always are). */
  wants(kind: NotifyKind): boolean {
    return this.configured && (kind === 'test' || this.opts.cfg.notify.on.has(kind));
  }

  /** Link to the event page, when SPARKFLY_PUBLIC_URL says where we live. */
  eventUrl(eventId: number | undefined): string | null {
    const base = this.opts.cfg.publicUrl;
    return base && eventId !== undefined ? `${base}/events/${eventId}` : null;
  }

  async send(n: Notification): Promise<NotifyResult> {
    const { notify } = this.opts.cfg;
    if (!notify.url || !this.wants(n.kind)) return { ok: true };
    const link = this.eventUrl(n.eventId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      let init: RequestInit;
      if (notify.format === 'ntfy') {
        const headers: Record<string, string> = {
          'content-type': 'text/plain; charset=utf-8',
          // Header values must be latin-1; ntfy accepts RFC 2047 for the rest.
          title: encodeHeader(n.title),
          tags: n.kind === 'test' ? 'white_check_mark' : 'warning',
        };
        if (n.kind === 'dead') headers.priority = 'high';
        if (link) headers.click = link;
        init = { method: 'POST', headers, body: n.message };
      } else {
        const text = `${n.title}\n${n.message}${link ? `\n${link}` : ''}`;
        init = {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            app: APP_NAME,
            kind: n.kind,
            title: n.title,
            message: n.message,
            event_id: n.eventId ?? null,
            url: link,
            text,
            content: text,
          }),
        };
      }
      const res = await this.fetchImpl(notify.url, { ...init, signal: controller.signal });
      if (!res.ok) {
        const body = (await res.text()).trim().slice(0, 200);
        throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ''}`);
      }
      this.opts.logger.info({ kind: n.kind, event: n.eventId }, 'notification sent');
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error && err.name === 'AbortError' ? 'timed out' : err instanceof Error ? err.message : String(err);
      this.opts.logger.warn({ kind: n.kind, event: n.eventId, err: error }, 'notification failed');
      return { ok: false, error };
    } finally {
      clearTimeout(timer);
    }
  }
}

function encodeHeader(s: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

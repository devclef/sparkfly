import type { BackfillScan, CandidateStatus } from '../core/backfill.js';
import type { FireflyWebhook } from '../firefly/client.js';
import { describeSplit } from '../rules/match.js';
import { esc, escText, page } from './layout.js';

/**
 * Setup page: the Firefly side (webhook auto-registration, backfill) and
 * failure notifications. Everything Firefly-related needs FIREFLY_URL and
 * FIREFLY_PAT; without them the page explains what to set.
 */

export interface SetupPageData {
  fireflyUrl: string | null;
  fireflyConfigured: boolean;
  /** The URL Firefly should deliver to. */
  webhookUrl: string;
  /** null = not loaded (no API access); otherwise the Firefly webhook list. */
  webhooks: FireflyWebhook[] | null;
  webhooksError: string | null;
  /** Where the active signing secret comes from. */
  secretSource: 'env' | 'registered' | 'none';
  dryRun: boolean;
  notify: { url: string | null; format: string; on: string[]; publicUrl: string | null };
  backfill: {
    start: string;
    end: string;
    scan: BackfillScan | null;
    error: string | null;
    /** Set after "queue" was pressed. */
    queued: { queued: number; duplicates: number } | null;
  };
  /** One-off success / error banner after a POST. */
  flash: { kind: 'ok' | 'err'; text: string } | null;
}

const STATUS_LABEL: Record<CandidateStatus, string> = {
  queue: '<span class="badge ok">will be logged</span>',
  linked: '<span class="badge muted">already logged</span>',
  'no-match': '<span class="badge warn">no rule</span>',
  'skip-tag': '<span class="badge info">skip tag</span>',
};

/** Hide the token part of a notification URL (ntfy topics are secrets too). */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const tail = u.pathname.length > 1 ? '/…' : '';
    return `${u.protocol}//${u.host}${tail}`;
  } catch {
    return '(invalid URL)';
  }
}

export function renderSetupPage(d: SetupPageData): string {
  const flash = d.flash
    ? `<div class="${d.flash.kind === 'ok' ? 'infobox' : 'errbox'}">${escText(d.flash.text)}</div>`
    : '';
  const apiMissing = `<div class="warnbox">Set <code>FIREFLY_URL</code> and <code>FIREFLY_PAT</code> (a Firefly <em>Personal Access Token</em> from <em>Options → Profile → OAuth</em>) to use this section.</div>`;

  // ---- webhook ----
  const ours = (d.webhooks ?? []).filter((w) => w.url === d.webhookUrl);
  const hookRows = (d.webhooks ?? [])
    .map(
      (w) => `<tr>
        <td>${esc(w.title || '(untitled)')}${w.url === d.webhookUrl ? ' <span class="badge ok">this Sparkfly</span>' : ''}</td>
        <td class="mono">${esc(w.url)}</td>
        <td>${w.triggers.map((t) => `<code>${esc(t)}</code>`).join(' ')}</td>
        <td>${w.active ? '<span class="badge ok">active</span>' : '<span class="badge muted">inactive</span>'}</td>
      </tr>`,
    )
    .join('\n');
  const secretNote =
    d.secretSource === 'env' ? 'Signing secret: <code>FIREFLY_WEBHOOK_SECRET</code> from the environment.' :
    d.secretSource === 'registered' ? 'Signing secret: stored when Sparkfly registered the webhook.' :
    '<span class="badge err">no signing secret</span> — register the webhook here, or set <code>FIREFLY_WEBHOOK_SECRET</code>.';
  const missingTriggers = ours.length > 0
    ? ['STORE_TRANSACTION', 'UPDATE_TRANSACTION', 'DESTROY_TRANSACTION'].filter((t) => !ours.some((w) => w.triggers.includes(t)))
    : [];
  const webhookSection = !d.fireflyConfigured
    ? apiMissing
    : `
<div class="card">
  <div class="row">
    <div><span>Firefly</span><code>${esc(d.fireflyUrl ?? '')}</code></div>
    <div><span>Delivers to</span><code>${esc(d.webhookUrl)}</code></div>
  </div>
  <p class="muted" style="margin:.75rem 0 0">${secretNote}</p>
</div>
${d.webhooksError ? `<div class="errbox">Could not list Firefly webhooks: ${escText(d.webhooksError)}</div>` : ''}
${missingTriggers.length > 0 ? `<div class="warnbox">The registered webhook lacks ${missingTriggers.map((t) => `<code>${t}</code>`).join(', ')} (older Firefly versions take one trigger per webhook) — add them in Firefly under <em>Automation → Webhooks</em>.</div>` : ''}
<div class="card table-wrap">
  <table>
    <thead><tr><th>Title</th><th>URL</th><th>Triggers</th><th></th></tr></thead>
    <tbody>${hookRows || `<tr><td colspan="4" class="muted">${d.webhooks ? 'no webhooks in Firefly yet' : 'not loaded'}</td></tr>`}</tbody>
  </table>
</div>
<form method="post" action="/setup/webhook" class="card">
  <div class="field" style="max-width:560px"><label for="s-url">Webhook URL Firefly should call</label>
    <input id="s-url" name="url" value="${esc(d.webhookUrl)}">
    <span class="hint">Must be reachable from Firefly, e.g. <code>http://sparkfly:8080/hooks/firefly</code> on a shared Docker network. Set <code>SPARKFLY_PUBLIC_URL</code> to change the default.</span>
  </div>
  <button type="submit"${ours.length > 0 ? ' class="ghost"' : ''}>${ours.length > 0 ? 'register another' : 'register webhook in Firefly'}</button>
  <span class="hint muted">Firefly webhooks must be allowed by an admin (<em>Administration → Configuration</em>).</span>
</form>`;

  // ---- backfill ----
  const b = d.backfill;
  const scan = b.scan;
  let scanHtml = '';
  if (scan) {
    const counts = { queue: 0, linked: 0, 'no-match': 0, 'skip-tag': 0 } as Record<CandidateStatus, number>;
    for (const c of scan.candidates) counts[c.status] += 1;
    const shown = scan.candidates.filter((c) => c.status !== 'no-match');
    const rows = shown
      .slice(0, 200)
      .map((c) => c.splits
        .map((s, i) => `<tr>
          <td class="mono">${i === 0 ? esc(c.groupId) : ''}</td>
          <td class="nowrap">${esc(s.split.date.slice(0, 16).replace('T', ' '))}</td>
          <td>${esc(describeSplit(s.split))}</td>
          <td>${s.rules.map((r) => `<span class="badge ok">${esc(r)}</span>`).join(' ') || '<span class="muted">—</span>'}</td>
          <td>${i === 0 ? STATUS_LABEL[c.status] : ''}</td>
        </tr>`)
        .join(''))
      .join('\n');
    scanHtml = `
<div class="stats">
  <div class="stat ok"><b>${counts.queue}</b><span>to log</span></div>
  <div class="stat"><b>${counts.linked}</b><span>already logged</span></div>
  <div class="stat"><b>${counts['no-match'] + counts['skip-tag']}</b><span>no rule / skip tag</span></div>
  <div class="stat"><b>${scan.groups}</b><span>transactions scanned</span></div>
</div>
${scan.truncated ? `<div class="warnbox">The range has more transactions than one run scans (${scan.groups}); pick a shorter range and run again for the rest.</div>` : ''}
${scan.invalidSplits > 0 ? `<div class="warnbox">${scan.invalidSplits} split(s) could not be read and were left out.</div>` : ''}
<div class="card table-wrap">
  <table>
    <thead><tr><th>Group</th><th>Date</th><th>Transaction</th><th>Rule</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="muted">no transaction in this range matches a rule</td></tr>'}</tbody>
  </table>
  ${shown.length > 200 ? `<p class="muted">… and ${shown.length - 200} more</p>` : ''}
</div>
${counts.queue > 0 && !b.queued ? `
<form method="post" action="/setup/backfill" class="card">
  <input type="hidden" name="start" value="${esc(scan.start)}">
  <input type="hidden" name="end" value="${esc(scan.end)}">
  <input type="hidden" name="mode" value="run">
  <button type="submit">log ${counts.queue} transaction${counts.queue === 1 ? '' : 's'} in SparkyFitness</button>
  ${d.dryRun ? '<span class="badge warn">dry run — they are only evaluated</span>' : ''}
</form>` : ''}`;
  }
  const queuedHtml = b.queued
    ? `<div class="infobox">Queued ${b.queued.queued} transaction${b.queued.queued === 1 ? '' : 's'}${b.queued.duplicates ? ` (${b.queued.duplicates} were already backfilled before)` : ''}. Follow them on the <a href="/?view=all">dashboard</a>.</div>`
    : '';
  const backfillSection = !d.fireflyConfigured
    ? apiMissing
    : `
<p class="muted">Run the current rules over past Firefly transactions. Only transactions that match a rule and are not logged yet are sent to SparkyFitness; they show up on the dashboard like webhook deliveries. Preview first — nothing is written until you confirm.</p>
${b.error ? `<div class="errbox">${escText(b.error)}</div>` : ''}
${queuedHtml}
<form method="post" action="/setup/backfill" class="card">
  <div class="grid">
    <div class="field"><label for="b-start">From</label><input id="b-start" name="start" type="date" required value="${esc(b.start)}"></div>
    <div class="field"><label for="b-end">To</label><input id="b-end" name="end" type="date" required value="${esc(b.end)}"></div>
  </div>
  <input type="hidden" name="mode" value="preview">
  <button type="submit">preview</button>
</form>
${scanHtml}`;

  // ---- notifications ----
  const n = d.notify;
  const notifySection = `
<div class="card">
  <div class="row">
    <div><span>Target</span>${n.url ? `<code>${esc(redactUrl(n.url))}</code>` : '<span class="muted">off — set <code>NOTIFY_URL</code></span>'}</div>
    <div><span>Format</span><code>${esc(n.format)}</code></div>
    <div><span>Notify on</span>${n.on.map((o) => `<code>${esc(o)}</code>`).join(' ')}</div>
    <div><span>Links</span>${n.publicUrl ? `<code>${esc(n.publicUrl)}</code>` : '<span class="muted">set <code>SPARKFLY_PUBLIC_URL</code> to link to events</span>'}</div>
  </div>
  ${n.url ? `<form method="post" action="/setup/notify-test" style="margin-top:.9rem"><button type="submit" class="ghost">send a test notification</button></form>` : ''}
</div>`;

  const body = `
<h1>Setup <small>Firefly webhook, backfill, notifications</small></h1>
${flash}
<h2 id="webhook">Firefly webhook</h2>
${webhookSection}
<h2 id="backfill">Backfill</h2>
${backfillSection}
<h2 id="notifications">Failure notifications</h2>
${notifySection}`;
  return page({ title: 'Setup', active: 'setup', body });
}

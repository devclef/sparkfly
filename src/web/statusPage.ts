import { summarizeAction, summarizeMatch, type CompiledRule } from '../rules/compile.js';
import { describeFilterMatch, type WebhookFilter } from '../rules/webhookFilters.js';
import { esc, page } from './layout.js';

/** One transaction (split) of a webhook delivery, as shown on the dashboard. */
export interface WebhookRow {
  eventId: number;
  trigger: string;
  status: string;
  attempts: number;
  summary: string | null;
  receivedAt: string;
  /** null when the payload has no transactions or no longer parses. */
  tx: {
    journal: string;
    /** Transaction date in the configured TZ, "YYYY-MM-DD HH:MM". */
    date: string;
    type: string;
    description: string | null;
    amount: string;
    currency: string;
    source: string | null;
    destination: string | null;
    budget: string | null;
    category: string | null;
    tags: string[];
  } | null;
  /**
   * What the current rules make of this transaction: matched (rule names),
   * needs-rule (nothing matches), skip-tag, or n/a (e.g. deletes).
   */
  outcome: 'matched' | 'needs-rule' | 'skip-tag' | 'n/a';
  rules: string[];
  /** Hidden by a webhook filter (only rendered when "show hidden" is on). */
  hidden: boolean;
}

export type WebhookView = 'shown' | 'needs-rule' | 'all';

export interface StatusPageData {
  version: string;
  dryRun: boolean;
  sparkyUrl: string;
  tz: string;
  /** e.g. "managed in the UI" or "imported from /config/rules.yaml". */
  rulesSource: string;
  rules: CompiledRule[];
  webhookUrl: string;
  webhookSecret: string | null;
  adminPasswordSet: boolean;
  webhooks: WebhookRow[];
  view: WebhookView;
  /** Counts over the recent window, before the row limit. */
  counts: { shown: number; hidden: number; needsRule: number };
  filters: WebhookFilter[];
  links: {
    journal_id: string;
    rule_id: string;
    kind: string;
    sparky_entry_id: string | null;
    createdAt: string;
  }[];
  queueDepth: number;
}

const STATUS_CLASS: Record<string, string> = {
  succeeded: 'ok',
  pending: 'warn',
  processing: 'warn',
  failed: 'err',
  skipped: 'muted',
  dead: 'err',
};

export function renderStatusPage(d: StatusPageData): string {
  const ruleRows = d.rules
    .map(
      (r, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td class="mono">${esc(r.name)}</td>
        <td>${esc(summarizeMatch(r))}</td>
        <td>${esc(summarizeAction(r))}${r.cont ? ' <span class="muted">+continue</span>' : ''}</td>
      </tr>`,
    )
    .join('\n');

  const linkRows = d.links
    .map(
      (l) => `<tr>
        <td class="mono">${esc(l.journal_id)}</td>
        <td class="mono">${esc(l.rule_id)}</td>
        <td>${esc(l.kind)}</td>
        <td class="mono">${l.sparky_entry_id ? esc(l.sparky_entry_id) : '<span class="muted">—</span>'}</td>
        <td class="muted">${esc(l.createdAt.replace('T', ' ').slice(0, 19))}</td>
      </tr>`,
    )
    .join('\n');

  const eventRows = d.webhooks.map(renderWebhookRow).join('\n');

  const activeFilters = d.filters.filter((f) => f.enabled);
  const filterNote = activeFilters.length === 0
    ? 'No webhook filters — every Firefly transaction is shown. <a href="/filters">Add filters</a> to focus on the ones that could be meals (e.g. include budget <code>Food</code>, exclude destination <code>Landlord</code>).'
    : `Filters: ${activeFilters
        .map((f) => `<span class="badge ${f.mode === 'include' ? 'info' : 'warn'}">${f.mode}</span> ${esc(describeFilterMatch(f.match))}`)
        .join(' · ')} — <a href="/filters">edit</a>`;
  const viewLink = (v: WebhookView, label: string): string =>
    `<a href="/?view=${v}" class="${d.view === v ? 'on' : ''}">${label}</a>`;
  const dryRunBadge = d.dryRun
    ? '<span class="badge warn">dry run</span>'
    : `<span class="badge ok">writing to ${esc(d.sparkyUrl)}</span>`;

  const body = `
<h1>Dashboard <small>Firefly III → SparkyFitness</small></h1>
<div class="row">
  ${dryRunBadge}
  <span class="muted">TZ ${esc(d.tz)}</span>
  <span class="muted">queue depth ${d.queueDepth}</span>
</div>
${d.adminPasswordSet ? '' : '<div class="warnbox">No <code>ADMIN_PASSWORD</code> is set — anyone who can reach this port sees the setup details below. Put Sparkfly behind your reverse proxy (or set the password) before exposing it.</div>'}

<h2>Setup — paste into Firefly</h2>
<div class="card">
  <div class="row">
    <div><span>Webhook URL</span><code>${esc(d.webhookUrl)}</code></div>
    <div><span>Triggers</span><code>STORE_TRANSACTION</code> <code>UPDATE_TRANSACTION</code> <code>DESTROY_TRANSACTION</code></div>
    <div><span>Response</span><code>TRANSACTIONS</code></div>
    <div><span>Deliveries</span><code>JSON</code></div>
  </div>
  <div class="row" style="margin-top:.9rem">
    <div>
      <span>Webhook secret (Firefly signs with HMAC-SHA3-256)</span>
      <code id="secret">${d.webhookSecret ? '••••••••' : '<span class="muted">not configured — all deliveries will be rejected</span>'}</code>
    </div>
    ${d.webhookSecret ? '<button onclick="document.getElementById(\'secret\').textContent=window.sparkflySecret">reveal</button>' : ''}
  </div>
</div>

<h2>Rules <a href="/rules" style="float:right;text-transform:none;letter-spacing:0">manage in the UI →</a></h2>
<div class="card row" style="padding:.6rem 1.25rem">
  <div><span>Source</span><span>${esc(d.rulesSource)}</span></div>
</div>
<div class="card" style="padding:.25rem 1.25rem">
  <table>
    <thead><tr><th>#</th><th>Name</th><th>Match</th><th>Action</th></tr></thead>
    <tbody>${ruleRows || '<tr><td colspan="4" class="muted">no rules — <a href="/rules/new">add one</a> or create one from an incoming transaction</td></tr>'}</tbody>
  </table>
</div>

<h2>Links — journal → SparkyFitness entry</h2>
<div class="card" style="padding:.25rem 1.25rem">
  <table>
    <thead><tr><th>Journal</th><th>Rule</th><th>Kind</th><th>Entry id</th><th>Touched</th></tr></thead>
    <tbody>${linkRows || '<tr><td colspan="5" class="muted">none yet</td></tr>'}</tbody>
  </table>
</div>

<h2 id="webhooks">Recent webhooks</h2>
<div class="muted" style="font-size:.9rem">${filterNote}</div>
<div class="filterbar">
  ${viewLink('shown', `Shown (${d.counts.shown})`)}
  ${viewLink('needs-rule', `Needs a rule (${d.counts.needsRule})`)}
  ${viewLink('all', `All incl. hidden (${d.counts.shown + d.counts.hidden})`)}
</div>
<div class="card" style="padding:.25rem 1.25rem; overflow-x:auto">
  <table>
    <thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Destination</th><th>Budget</th><th>Category</th><th>Rule</th><th>Status</th><th></th></tr></thead>
    <tbody>${eventRows || `<tr><td colspan="9" class="muted">${d.counts.shown + d.counts.hidden === 0 ? 'none yet — point the webhook at the URL above' : 'nothing in this view — try another tab above'}</td></tr>`}</tbody>
  </table>
</div></div>`;

  return page({
    title: 'Sparkfly',
    active: 'dashboard',
    body,
    scripts: d.webhookSecret ? `window.sparkflySecret=${JSON.stringify(d.webhookSecret)};` : undefined,
  });
}

const dash = '<span class="muted">—</span>';
const cell = (v: string | null | undefined): string => (v ? esc(v) : dash);

function renderWebhookRow(w: WebhookRow): string {
  const tx = w.tx;
  const status = `<span class="badge ${STATUS_CLASS[w.status] ?? 'muted'}">${esc(w.status)}</span>${w.attempts ? ` <span class="muted">×${w.attempts}</span>` : ''}`;
  const trigger = w.trigger.replace(/_TRANSACTION$/, '').toLowerCase();
  const outcome =
    w.outcome === 'matched' ? w.rules.map((r) => `<span class="badge ok">${esc(r)}</span>`).join(' ') :
    w.outcome === 'needs-rule' ? '<span class="badge warn" title="No rule matches this transaction">needs rule</span>' :
    w.outcome === 'skip-tag' ? '<span class="badge info" title="Has the global skip tag">skip tag</span>' :
    dash;
  const ruleLink = tx && (w.trigger === 'STORE_TRANSACTION' || w.trigger === 'UPDATE_TRANSACTION')
    ? `<a class="btn ${w.outcome === 'needs-rule' ? '' : 'ghost'}" href="/rules/new?event=${w.eventId}&amp;split=${encodeURIComponent(tx.journal)}">rule</a>`
    : '';
  const hideLink = tx && !w.hidden && (tx.destination || tx.description)
    ? `<a class="btn ghost" title="Hide transactions like this from the dashboard" href="/filters?mode=exclude&amp;${tx.destination ? `destination=${encodeURIComponent(tx.destination)}` : `description=${encodeURIComponent(tx.description ?? '')}`}">hide</a>`
    : '';
  const retry = w.status === 'dead'
    ? `<form method="post" action="/events/${w.eventId}/retry" style="display:inline"><button type="submit" title="Re-queue this event with a fresh retry budget">retry</button></form>`
    : '';
  const received = esc(w.receivedAt.replace('T', ' ').slice(0, 16));
  const meta = `<div class="tx-sub">#${w.eventId} · ${esc(trigger)}${tx ? ` · ${esc(tx.type)}` : ''}${w.hidden ? ' · <span class="badge muted">hidden by filter</span>' : ''}</div>`;
  if (!tx) {
    return `<tr${w.hidden ? ' class="hidden-row"' : ''}>
        <td class="nowrap">${received}</td>
        <td>${cell(w.summary)}${meta}</td>
        <td></td><td></td><td></td><td></td>
        <td>${outcome}</td>
        <td>${status}</td>
        <td class="actions"><a class="btn ghost" href="/events/${w.eventId}">activity</a>${retry}</td>
      </tr>`;
  }
  const tags = tx.tags.length ? `<div class="tx-sub">${tx.tags.map((t) => `#${esc(t)}`).join(' ')}</div>` : '';
  return `<tr${w.hidden ? ' class="hidden-row"' : ''}>
        <td class="nowrap">${esc(tx.date)}<div class="tx-sub" title="received">rcvd ${received}</div></td>
        <td><span class="tx-desc">${cell(tx.description)}</span>${meta}${tags}</td>
        <td class="amount">${esc(tx.amount)} <span class="muted">${esc(tx.currency)}</span></td>
        <td>${cell(tx.destination)}${tx.source ? `<div class="tx-sub">from ${esc(tx.source)}</div>` : ''}</td>
        <td>${cell(tx.budget)}</td>
        <td>${cell(tx.category)}</td>
        <td>${outcome}</td>
        <td title="${esc(w.summary ?? '')}">${status}</td>
        <td class="actions"><a class="btn ghost" href="/events/${w.eventId}">activity</a>${ruleLink}${hideLink}${retry}</td>
      </tr>`;
}

// ------------------------------------------------------------------ //
// Webhook filters page
// ------------------------------------------------------------------ //

export function renderFiltersPage(opts: {
  filters: WebhookFilter[];
  errors: string[];
  prefill: Record<string, string>;
}): string {
  const p = opts.prefill;
  const rows = opts.filters
    .map(
      (f) => `<tr>
        <td><span class="badge ${f.mode === 'include' ? 'info' : 'warn'}">${f.mode}</span></td>
        <td>${esc(f.name)}${f.enabled ? '' : ' <span class="badge muted">disabled</span>'}</td>
        <td class="mono">${esc(describeFilterMatch(f.match))}</td>
        <td class="actions">
          <form method="post" action="/filters/${f.id}/toggle" style="display:inline"><button type="submit" class="ghost">${f.enabled ? 'disable' : 'enable'}</button></form>
          <form method="post" action="/filters/${f.id}/delete" style="display:inline"><button type="submit" class="danger">delete</button></form>
        </td>
      </tr>`,
    )
    .join('\n');
  const input = (name: string, label: string, hint: string): string => `
    <div class="field"><label for="f-${name}">${label}</label>
      <input id="f-${name}" name="${name}" value="${esc(p[name] ?? '')}">
      <span class="hint">${hint}</span></div>`;
  const mode = p.mode === 'include' ? 'include' : 'exclude';
  const type = p.type ?? '';
  const errors = opts.errors.length
    ? `<div class="errbox">Could not save the filter:<ul>${opts.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';
  const body = `
<h1>Webhook filters <small>which transactions the dashboard shows</small></h1>
<div class="infobox">
  Firefly sends every transaction to Sparkfly. Use filters to keep the dashboard focused on the ones that could become meals, so it is obvious which still <span class="badge warn">need a rule</span>.
  <ul style="margin:.4rem 0 0">
    <li><strong>Include</strong> — when any include filter is enabled, only transactions matching at least one are shown.</li>
    <li><strong>Exclude</strong> — transactions matching any exclude filter are hidden.</li>
    <li>Within a filter all filled-in fields must match. Values match exactly (case-insensitive) or as a regex literal like <code>/starbucks|costa/i</code>.</li>
    <li>Filters only change what is displayed. Rules still run on every transaction, and hidden ones stay under <a href="/?view=all">All incl. hidden</a>.</li>
  </ul>
</div>

<div class="card" style="padding:.25rem 1.25rem">
  <table>
    <thead><tr><th>Mode</th><th>Name</th><th>Conditions</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="muted">no filters yet — every transaction is shown</td></tr>'}</tbody>
  </table>
</div>

<h2>Add a filter</h2>
${errors}
<form method="post" action="/filters" class="card">
  <div class="grid">
    <div class="field"><label for="f-mode">Mode</label>
      <select id="f-mode" name="mode">
        <option value="include"${mode === 'include' ? ' selected' : ''}>include — only show matching</option>
        <option value="exclude"${mode === 'exclude' ? ' selected' : ''}>exclude — hide matching</option>
      </select></div>
    ${input('name', 'Name (optional)', 'defaults to the conditions')}
    <div class="field"><label for="f-type">Type</label>
      <select id="f-type" name="type">
        <option value=""${type === '' ? ' selected' : ''}>any</option>
        ${['withdrawal', 'deposit', 'transfer'].map((t) => `<option value="${t}"${type === t ? ' selected' : ''}>${t}</option>`).join('')}
      </select></div>
    ${input('budget', 'Budget', 'e.g. Food')}
    ${input('category', 'Category', 'e.g. /eating out|groceries/i')}
    ${input('description', 'Description', 'e.g. /lunch/i')}
    ${input('destination', 'Destination account', 'e.g. Indian Garden')}
    ${input('source', 'Source account', 'e.g. Checking')}
    ${input('tag', 'Tag', 'matches if any tag matches')}
  </div>
  <button type="submit">add filter</button>
</form>`;
  return page({ title: 'Webhook filters', active: 'filters', body });
}

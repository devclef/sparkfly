import { summarizeAction, summarizeMatch, type CompiledRule } from '../rules/compile.js';
import { esc, page } from './layout.js';

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
  events: {
    id: number;
    trigger: string;
    status: string;
    attempts: number;
    summary: string | null;
    createdAt: string;
  }[];
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

  const eventRows = d.events
    .map(
      (e) => `<tr>
        <td class="num">${e.id}</td>
        <td class="mono">${esc(e.trigger)}</td>
        <td><span class="badge ${STATUS_CLASS[e.status] ?? 'muted'}">${esc(e.status)}</span>${e.attempts ? ` <span class="muted">×${e.attempts}</span>` : ''}</td>
        <td>${esc(e.summary ?? '—')}</td>
        <td class="muted">${esc(e.createdAt.replace('T', ' ').slice(0, 19))}</td>
        <td class="actions">
          <a class="btn ghost" href="/events/${e.id}">activity</a>
          ${e.trigger === 'STORE_TRANSACTION' || e.trigger === 'UPDATE_TRANSACTION' ? `<a class="btn ghost" href="/rules/new?event=${e.id}">rule</a>` : ''}
          ${e.status === 'dead' ? `<form method="post" action="/events/${e.id}/retry" style="display:inline"><button type="submit" title="Re-queue this event with a fresh retry budget">retry</button></form>` : ''}
        </td>
      </tr>`,
    )
    .join('\n');

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

<h2>Recent webhooks</h2>
<div class="card" style="padding:.25rem 1.25rem">
  <table>
    <thead><tr><th>#</th><th>Trigger</th><th>Status</th><th>Summary</th><th>Received</th><th></th></tr></thead>
    <tbody>${eventRows || '<tr><td colspan="6" class="muted">none yet — point the webhook at the URL above</td></tr>'}</tbody>
  </table>
</div>`;

  return page({
    title: 'Sparkfly',
    active: 'dashboard',
    body,
    scripts: d.webhookSecret ? `window.sparkflySecret=${JSON.stringify(d.webhookSecret)};` : undefined,
  });
}

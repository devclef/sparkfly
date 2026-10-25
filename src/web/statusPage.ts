import { summarizeAction, summarizeMatch, type CompiledRule } from '../rules/compile.js';

export interface StatusPageData {
  version: string;
  dryRun: boolean;
  sparkyUrl: string;
  tz: string;
  rulesLoadedFrom: string | null;
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
  queueDepth: number;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

  const eventRows = d.events
    .map(
      (e) => `<tr>
        <td class="num">${e.id}</td>
        <td class="mono">${esc(e.trigger)}</td>
        <td><span class="badge ${STATUS_CLASS[e.status] ?? 'muted'}">${esc(e.status)}</span>${e.attempts ? ` <span class="muted">×${e.attempts}</span>` : ''}</td>
        <td>${esc(e.summary ?? '—')}</td>
        <td class="muted">${esc(e.createdAt.replace('T', ' ').slice(0, 19))}</td>
      </tr>`,
    )
    .join('\n');

  const dryRunBadge = d.dryRun
    ? '<span class="badge warn">dry run</span>'
    : `<span class="badge ok">writing to ${esc(d.sparkyUrl)}</span>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sparkfly</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { font: 15px/1.5 system-ui, -apple-system, sans-serif; margin: 0 auto; max-width: 1080px; padding: 2rem 1.25rem 4rem; background: #101318; color: #e6e9ee; }
  h1 { margin: 0; font-size: 1.6rem; } h1 small { color: #8b93a3; font-weight: 400; }
  h2 { margin: 2.25rem 0 .75rem; font-size: 1.1rem; text-transform: uppercase; letter-spacing: .06em; color: #8b93a3; }
  .card { background: #171c24; border: 1px solid #232a36; border-radius: 10px; padding: 1rem 1.25rem; margin: .75rem 0; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
  .row { display: flex; gap: 1.5rem; flex-wrap: wrap; align-items: center; }
  .row div span { display: block; color: #8b93a3; font-size: .8rem; }
  code { background: #0c0f14; border: 1px solid #232a36; border-radius: 6px; padding: .15em .45em; }
  button { background: #2b6cb0; color: #fff; border: 0; border-radius: 6px; padding: .3em .8em; cursor: pointer; font: inherit; font-size: .85em; }
  button:hover { background: #3182ce; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid #232a36; vertical-align: top; }
  th { color: #8b93a3; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; }
  .num { color: #8b93a3; }
  .badge { display: inline-block; border-radius: 999px; padding: .05em .7em; font-size: .8rem; }
  .badge.ok { background: #1c3527; color: #6ee7a0; }
  .badge.warn { background: #3a2f14; color: #f6c453; }
  .badge.err { background: #3a1a1c; color: #f28b8b; }
  .muted { color: #8b93a3; }
  .warnbox { background: #3a2f14; border: 1px solid #6b5416; color: #f6c453; border-radius: 10px; padding: .6rem 1rem; margin: .75rem 0; }
</style>
</head>
<body>
<h1>⚡ Sparkfly <small>v${esc(d.version)} · Firefly III → SparkyFitness</small></h1>
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
    <div><span>Triggers</span><code>STORE_TRANSACTION</code> <span class="muted">(add UPDATE/DESTROY in milestone 2)</span></div>
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

<h2>Rules ${d.rulesLoadedFrom ? `<span class="muted mono">(${esc(d.rulesLoadedFrom)})</span>` : '<span class="muted">— no rules file found, nothing will be logged</span>'}</h2>
<div class="card" style="padding:.25rem 1.25rem">
  <table>
    <thead><tr><th>#</th><th>Name</th><th>Match</th><th>Action</th></tr></thead>
    <tbody>${ruleRows || '<tr><td colspan="4" class="muted">no rules</td></tr>'}</tbody>
  </table>
</div>

<h2>Recent webhooks</h2>
<div class="card" style="padding:.25rem 1.25rem">
  <table>
    <thead><tr><th>#</th><th>Trigger</th><th>Status</th><th>Summary</th><th>Received</th></tr></thead>
    <tbody>${eventRows || '<tr><td colspan="5" class="muted">none yet — point the webhook at the URL above</td></tr>'}</tbody>
  </table>
</div>
${d.webhookSecret ? `<script>window.sparkflySecret=${JSON.stringify(d.webhookSecret)};</script>` : ''}
</body>
</html>`;
}

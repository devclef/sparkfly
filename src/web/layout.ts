import { VERSION } from '../constants.js';

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Escape for element content, where quotes are inert. (In attribute values, use {@link esc}.) */
export const escText = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Shared look for every page (dashboard, rules, events). Kept in one place
 * so the hand-rolled UI stays consistent.
 */
export const PAGE_CSS = `
  :root { color-scheme: dark; }
  body { font: 15px/1.5 system-ui, -apple-system, sans-serif; margin: 0 auto; max-width: 1120px; padding: 1.5rem 1.25rem 4rem; background: #101318; color: #e6e9ee; }
  h1 { margin: 0 0 1rem; font-size: 1.5rem; } h1 small { color: #8b93a3; font-weight: 400; }
  h2 { margin: 2rem 0 .6rem; font-size: 1.05rem; text-transform: uppercase; letter-spacing: .06em; color: #8b93a3; }
  h3 { margin: 1.25rem 0 .5rem; font-size: .95rem; text-transform: uppercase; letter-spacing: .05em; color: #8b93a3; }
  .nav { display: flex; gap: .4rem 1rem; align-items: baseline; flex-wrap: wrap; margin-bottom: .75rem; }
  .nav .spacer { flex: 1; }
  .nav a { color: #6ea8fe; text-decoration: none; font-size: .95rem; }
  .nav a.active { color: #e6e9ee; font-weight: 600; }
  .card { background: #171c24; border: 1px solid #232a36; border-radius: 10px; padding: 1rem 1.25rem; margin: .75rem 0; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
  .row { display: flex; gap: 1.5rem; flex-wrap: wrap; align-items: center; }
  .row div span { display: block; color: #8b93a3; font-size: .8rem; }
  code { background: #0c0f14; border: 1px solid #232a36; border-radius: 6px; padding: .15em .45em; overflow-wrap: anywhere; }
  a { color: #6ea8fe; }
  button, .btn { background: #2b6cb0; color: #fff; border: 0; border-radius: 6px; padding: .3em .8em; cursor: pointer; font: inherit; font-size: .85em; text-decoration: none; display: inline-block; }
  button:hover, .btn:hover { background: #3182ce; }
  button.danger { background: #7f1d1d; } button.danger:hover { background: #991b1b; }
  button.ghost, .btn.ghost { background: #1f2733; border: 1px solid #2b3646; color: #c9d1dc; } button.ghost:hover, .btn.ghost:hover { background: #263140; }
  button:disabled { opacity: .4; cursor: default; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid #232a36; vertical-align: top; }
  th { color: #8b93a3; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; }
  .num { color: #8b93a3; }
  .muted { color: #8b93a3; }
  .badge { display: inline-block; border-radius: 999px; padding: .05em .7em; font-size: .8rem; }
  .badge.ok { background: #1c3527; color: #6ee7a0; }
  .badge.warn { background: #3a2f14; color: #f6c453; }
  .badge.err { background: #3a1a1c; color: #f28b8b; }
  .badge.info { background: #16283c; color: #6ea8fe; }
  .badge.muted { background: #1f2733; color: #8b93a3; }
  .warnbox { background: #3a2f14; border: 1px solid #6b5416; color: #f6c453; border-radius: 10px; padding: .6rem 1rem; margin: .75rem 0; }
  .infobox { background: #16283c; border: 1px solid #274b7a; color: #9ec5f8; border-radius: 10px; padding: .6rem 1rem; margin: .75rem 0; }
  .errbox { background: #3a1a1c; border: 1px solid #7f1d1d; color: #f28b8b; border-radius: 10px; padding: .6rem 1rem; margin: .75rem 0; }
  .errbox ul { margin: .25rem 0 0; padding-left: 1.2rem; }
  .field { display: flex; flex-direction: column; gap: .25rem; margin-bottom: .75rem; }
  .field label { color: #8b93a3; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  .field input, .field select, .field textarea { background: #0c0f14; border: 1px solid #232a36; border-radius: 6px; color: #e6e9ee; padding: .35em .6em; font: inherit; }
  .field input:focus, .field select:focus, .field textarea:focus { outline: 1px solid #2b6cb0; }
  .field .hint { color: #5c6675; font-size: .78rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0 .9rem; }
  .typeahead-list { position: relative; }
  .typeahead-list .tt { position: absolute; top: 100%; left: 0; right: 0; z-index: 5; background: #0c0f14; border: 1px solid #2b3646; border-radius: 6px; margin-top: 2px; max-height: 220px; overflow: auto; }
  .typeahead-list .tt button { display: block; width: 100%; text-align: left; background: none; color: #e6e9ee; border-radius: 0; padding: .35em .7em; }
  .typeahead-list .tt button:hover { background: #1f2733; }
  .typeahead-list .tt .variant { margin-left: 1.5rem; font-size: .85em; color: #8b93a3; }
  .plan-line { padding: .3rem .6rem; border-bottom: 1px solid #1d2430; }
  .plan-line:last-child { border-bottom: 0; }
  tr.hidden-row td { opacity: .45; }
  .tx-desc { font-weight: 500; }
  .tx-sub { color: #8b93a3; font-size: .8rem; }
  .amount { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .nowrap { white-space: nowrap; }
  .filterbar { display: flex; gap: .75rem; flex-wrap: wrap; align-items: center; margin: .25rem 0 .5rem; }
  .filterbar a.on { color: #e6e9ee; font-weight: 600; text-decoration: none; }
  .actions { display: flex; gap: .4rem; flex-wrap: wrap; align-items: center; }
  .actions form { display: inline; margin: 0; }
  .table-wrap { overflow-x: auto; padding: .25rem 1.25rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .75rem; margin: 1rem 0; }
  .stat { background: #171c24; border: 1px solid #232a36; border-radius: 10px; padding: .7rem 1rem; color: inherit; text-decoration: none; display: block; }
  a.stat:hover { border-color: #2b6cb0; }
  .stat b { display: block; font-size: 1.6rem; font-weight: 600; line-height: 1.2; }
  .stat span { color: #8b93a3; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  .stat.warn b { color: #f6c453; } .stat.err b { color: #f28b8b; } .stat.ok b { color: #6ee7a0; }
  details.card > summary { cursor: pointer; color: #8b93a3; font-size: .9rem; text-transform: uppercase; letter-spacing: .05em; list-style-position: inside; }
  details.card[open] > summary { margin-bottom: .75rem; }
  .use-val { background: none; border: 0; padding: 0; color: #6ea8fe; font-size: inherit; cursor: pointer; text-decoration: underline dotted; }
  .use-val:hover { background: none; color: #9ec5f8; }
  .section-head { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
  .section-head h2 { margin-bottom: .6rem; }
  .section-head a { font-size: .9rem; }
  @media (max-width: 640px) {
    body { padding: 1rem 1rem 3rem; font-size: 14px; }
    h1 { font-size: 1.3rem; } h1 small { display: block; font-size: .95rem; }
    .card { padding: .8rem 1rem; }
    .table-wrap { padding: .25rem .75rem; }
    .row { gap: .9rem; }
  }
`;

/** Full HTML document frame with the top navigation. */
export function page(opts: {
  title: string;
  active: 'dashboard' | 'rules' | 'filters' | 'setup';
  body: string;
  scripts?: string;
}): string {
  const nav = `
<div class="nav">
  <strong>⚡ Sparkfly</strong>
  <a href="/" class="${opts.active === 'dashboard' ? 'active' : ''}">Dashboard</a>
  <a href="/rules" class="${opts.active === 'rules' ? 'active' : ''}">Rules</a>
  <a href="/filters" class="${opts.active === 'filters' ? 'active' : ''}">Filters</a>
  <a href="/setup" class="${opts.active === 'setup' ? 'active' : ''}">Setup</a>
  <span class="spacer"></span>
  <span class="muted">v${esc(VERSION)}</span>
</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(opts.title)} · Sparkfly</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${PAGE_CSS}</style>
</head>
<body>
${nav}
${opts.body}
${opts.scripts ? `<script>${opts.scripts}</script>` : ''}
</body>
</html>`;
}

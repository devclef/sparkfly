import type { ActionSpec, MatchSpec } from '../rules/types.js';
import type { EventRow, LinkRow, RuleRow } from '../db/index.js';
import type { PlanLine } from '../core/processEvent.js';
import type { FireflySplit } from '../firefly/types.js';
import { esc, escText, PAGE_CSS, page } from './layout.js';

/** A rule with its JSON columns parsed, for rendering. */
export interface RuleView {
  id: number;
  name: string;
  match: MatchSpec;
  action: ActionSpec;
  cont: boolean;
  enabled: boolean;
  position: number;
}

export function ruleViewFromRow(row: RuleRow): RuleView {
  return {
    id: row.id,
    name: row.name,
    match: JSON.parse(row.match_json),
    action: JSON.parse(row.action_json),
    cont: row.cont === 1,
    enabled: row.enabled === 1,
    position: row.position,
  };
}

const STATUS_CLASS: Record<string, string> = {
  succeeded: 'ok',
  pending: 'warn',
  processing: 'warn',
  failed: 'err',
  skipped: 'muted',
  dead: 'err',
};

// ------------------------------------------------------------------ //
// Rules list
// ------------------------------------------------------------------ //

export function renderRulesList(opts: {
  rules: RuleView[];
  sparkyConfigured: boolean;
  importedFrom: string | null;
  rulesSourceFile: string;
}): string {
  const rows = opts.rules
    .map(
      (r, i) => `<tr>
        <td class="num">${r.position}</td>
        <td><a href="/rules/${r.id}/edit" class="mono">${esc(r.name)}</a>${r.cont ? ' <span class="muted">+continue</span>' : ''}${!r.enabled ? ' <span class="badge warn">disabled</span>' : ''}</td>
        <td>${describeMatch(r.match)}</td>
        <td>${describeAction(r.action)}</td>
        <td><div class="actions">
          <form method="post" action="/rules/${r.id}/move"><input type="hidden" name="dir" value="up"><button type="submit" class="ghost" ${i === 0 ? 'disabled' : ''} title="move up" aria-label="move up">↑</button></form>
          <form method="post" action="/rules/${r.id}/move"><input type="hidden" name="dir" value="down"><button type="submit" class="ghost" ${i === opts.rules.length - 1 ? 'disabled' : ''} title="move down" aria-label="move down">↓</button></form>
          <a class="btn ghost" href="/rules/${r.id}/edit">edit</a>
          <form method="post" action="/rules/${r.id}/delete" onsubmit="return confirm('Delete rule ${esc(r.name.replace(/['\\]/g, ''))}?')">
            <button type="submit" class="danger">delete</button>
          </form>
        </div></td>
      </tr>`,
    )
    .join('\n');

  const sourceNote = opts.importedFrom
    ? `Originally imported from <code>${esc(opts.importedFrom)}</code> — the UI is the source of truth from now on.`
    : `Managed in this UI (no YAML file needed. If you mount a <code>${esc(opts.rulesSourceFile)}</code> on first start, its rules are imported once).`;

  return page({
    title: 'Rules',
    active: 'rules',
    body: `
<div class="section-head">
  <h1>Rules <small>checked top to bottom, first match wins</small></h1>
  <a class="btn" href="/rules/new">+ new rule</a>
</div>
<div class="card row">
  <div><span>Source</span><span>${sourceNote}</span></div>
  <div><span>SparkyFitness search</span><span>${opts.sparkyConfigured ? '<span class="badge ok">available</span>' : '<span class="badge warn">not configured</span>'}</span></div>
</div>
${opts.rules.length === 0 ? '<div class="infobox">No rules yet — add one here, or create one from an incoming transaction on the <a href="/">dashboard</a>.</div>' : ''}
<div class="card table-wrap">
  <table>
    <thead><tr><th>#</th><th>Name</th><th>Match</th><th>Action</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" class="muted">no rules yet</td></tr>'}</tbody>
  </table>
</div>`,
  });
}

function describeMatch(m: MatchSpec): string {
  const bits: string[] = [];
  if (m.type) bits.push(m.type);
  const pat = (v: string | { pattern: string; flags?: string } | undefined): string =>
    v === undefined ? '' : typeof v === 'string' ? v : `/${v.pattern}/${v.flags ?? ''}`;
  if (m.source) bits.push(`source=${pat(m.source)}`);
  if (m.destination) bits.push(`dest=${pat(m.destination)}`);
  if (m.description) bits.push(`desc=${pat(m.description)}`);
  if (m.category) bits.push(`cat=${pat(m.category)}`);
  if (m.budget) bits.push(`budget=${pat(m.budget)}`);
  if (m.currency) bits.push(m.currency);
  if (m.amount) bits.push(`€ ${m.amount.min ?? '-∞'}…${m.amount.max ?? '∞'}`);
  if (m.tags_any?.length) bits.push(`tags+ ${m.tags_any.join(',')}`);
  if (m.tags_none?.length) bits.push(`tags− ${m.tags_none.join(',')}`);
  if (m.weekdays?.length) bits.push(m.weekdays.join(','));
  if (m.time) bits.push(`${m.time.from}–${m.time.to}`);
  return bits.length ? esc(bits.join(' · ')) : '<span class="muted">any transaction</span>';
}

function describeAction(a: ActionSpec): string {
  const target =
    a.log === 'meal' ? `meal ${esc(a.meal_template_id ?? '?')}` :
    a.log === 'food' ? `food ${esc(a.food_id ?? '?')}` :
    `foods: ${a.foods?.map((f) => esc(f.food_id)).join(', ') ?? ''}`;
  return `${target} <span class="muted">×${a.quantity} ${esc(a.unit)} · ${esc(a.meal_type)}</span>`;
}

// ------------------------------------------------------------------ //
// Rule form (new + edit, and "new from transaction" prefill)
// ------------------------------------------------------------------ //

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * "New rule from this transaction" prefill: start the match with just the
 * type and the place (destination, or the description when there is none).
 * Pre-filling every field would make the rule match only this exact
 * transaction; the other values are offered as one-click suggestions.
 * Deliberately no amount bounds — the rule should keep matching the place,
 * not this one-off price.
 */
function matchFromSplit(split: FireflySplit): MatchSpec {
  const m: MatchSpec = { type: split.type };
  if (split.destination_name) m.destination = split.destination_name;
  else if (split.description) m.description = split.description;
  return m;
}

export function renderRuleForm(opts: {
  view: RuleView | null;
  errors: string[];
  /** Populated when creating a rule from an incoming transaction. */
  fromTransaction: { eventId: number; split: FireflySplit } | null;
  sparkyConfigured: boolean;
}): string {
  const v = opts.view;
  const m: MatchSpec =
    v?.match ?? (opts.fromTransaction ? matchFromSplit(opts.fromTransaction.split) : {});
  const a: ActionSpec = v?.action ?? { log: 'meal', meal_type: 'auto', quantity: 1, unit: 'serving' };
  const val = (x: unknown): string => (x === undefined || x === null ? '' : String(x));
  const pat = (x: string | { pattern: string; flags?: string } | undefined): string =>
    x === undefined ? '' : typeof x === 'string' ? x : `/${x.pattern}/${x.flags ?? ''}`;

  const foodItems = (a.foods ?? [])
    .map(
      (f, i) => foodItemRow(
        i,
        f.food_id,
        f.variant_id ?? '',
        f.quantity,
        f.unit ?? '',
        f.note ?? '',
        true,
      ),
    )
    .join('\n');

  const banner = opts.fromTransaction
    ? `<div class="infobox">
        Creating a rule from transaction:
        <span class="mono">${esc(describeSplitLine(opts.fromTransaction.split))}</span><br>
        The type and destination are pre-filled; click a <em>use</em> suggestion under a field to narrow the match further.
        Choose what to log, then save — you will land on the transaction's test page to check the rule matches.
       </div>`
    : '';
  // One-click suggestions from the transaction for fields left empty.
  const tx = opts.fromTransaction?.split;
  const suggest = (field: string, value: string | null | undefined, current: string): string =>
    tx && value && value !== current
      ? `<span class="hint">this transaction: <button type="button" class="use-val" data-fill="${field}" data-value="${esc(value)}">use “${esc(value)}”</button></span>`
      : '';

  return page({
    title: v ? `Edit rule ${v.name}` : 'New rule',
    active: 'rules',
    body: `
<h1>${v ? `Edit rule <span class="mono">${esc(v.name)}</span>` : 'New rule'}</h1>
${banner}
${opts.errors.length > 0 ? `<div class="errbox"><strong>Could not save the rule:</strong><ul>${opts.errors.map((e) => `<li>${escText(e)}</li>`).join('')}</ul></div>` : ''}
${!opts.sparkyConfigured ? '<div class="warnbox">SparkyFitness is not configured (<code>SPARKY_URL</code>/<code>SPARKY_API_KEY</code>) — meal/food search is disabled, paste UUIDs by hand.</div>' : ''}
<form method="post" action="${v ? `/rules/${v.id}` : '/rules'}">
  ${opts.fromTransaction ? `<input type="hidden" name="from_event" value="${opts.fromTransaction.eventId}">` : ''}
  <div class="grid">
    <div class="field"><label for="r-name">Rule name</label><input id="r-name" name="name" required value="${esc(val(v?.name) || (tx ? tx.destination_name ?? tx.description ?? '' : ''))}" placeholder="Indian Garden lunch"></div>
    <div class="field"><label>Transaction type</label>
      <select name="type">
        <option value="" ${m.type === undefined ? 'selected' : ''}>any</option>
        <option value="withdrawal" ${m.type === 'withdrawal' ? 'selected' : ''}>withdrawal</option>
        <option value="deposit" ${m.type === 'deposit' ? 'selected' : ''}>deposit</option>
        <option value="transfer" ${m.type === 'transfer' ? 'selected' : ''}>transfer</option>
      </select>
    </div>
    <div class="field"><label for="r-destination">Destination</label><input id="r-destination" name="destination" value="${esc(pat(m.destination))}" placeholder="Indian Garden  or  /starbucks|costa/i">${suggest('destination', tx?.destination_name, pat(m.destination))}</div>
    <div class="field"><label for="r-source">Source</label><input id="r-source" name="source" value="${esc(pat(m.source))}">${suggest('source', tx?.source_name, pat(m.source))}</div>
    <div class="field"><label for="r-description">Description</label><input id="r-description" name="description" value="${esc(pat(m.description))}">${suggest('description', tx?.description, pat(m.description))}</div>
    <div class="field"><label for="r-category">Category</label><input id="r-category" name="category" value="${esc(pat(m.category))}">${suggest('category', tx?.category_name, pat(m.category))}</div>
    <div class="field"><label for="r-budget">Budget</label><input id="r-budget" name="budget" value="${esc(pat(m.budget))}">${suggest('budget', tx?.budget_name, pat(m.budget))}</div>
    <div class="field"><label for="r-currency">Currency</label><input id="r-currency" name="currency" value="${esc(val(m.currency))}" placeholder="any">${suggest('currency', tx?.currency_code, val(m.currency))}</div>
    <div class="field"><label>Amount min</label><input name="amount_min" value="${esc(val(m.amount?.min))}" inputmode="decimal"></div>
    <div class="field"><label>Amount max</label><input name="amount_max" value="${esc(val(m.amount?.max))}" inputmode="decimal"></div>
    <div class="field"><label for="r-tags_any">Tags any</label><input id="r-tags_any" name="tags_any" value="${esc((m.tags_any ?? []).join(', '))}" placeholder="lunch, dinner">${suggest('tags_any', tx?.tags.join(', '), (m.tags_any ?? []).join(', '))}</div>
    <div class="field"><label>Tags none</label><input name="tags_none" value="${esc((m.tags_none ?? []).join(', '))}" placeholder="paid-by-else"></div>
    <div class="field"><label>Weekdays</label><input name="weekdays" value="${esc((m.weekdays ?? []).join(', '))}" placeholder="mon-fri  or  sat, sun"></div>
    <div class="field"><label>Time from</label><input name="time_from" value="${esc(val(m.time?.from))}" placeholder="11:00"></div>
    <div class="field"><label>Time to</label><input name="time_to" value="${esc(val(m.time?.to))}" placeholder="15:30"></div>
  </div>

  <h3>Action</h3>
  <div class="grid">
    <div class="field"><label>Log</label>
      <select name="log" id="log">
        <option value="meal" ${a.log === 'meal' ? 'selected' : ''}>saved meal (meal_template_id)</option>
        <option value="food" ${a.log === 'food' ? 'selected' : ''}>single food (food_id)</option>
        <option value="foods" ${a.log === 'foods' ? 'selected' : ''}>several foods (list below)</option>
      </select>
    </div>
    <div class="field"><label>Meal type</label>
      <input name="meal_type" id="meal_type" list="meal-type-options" value="${esc(val(a.meal_type) || 'auto')}" placeholder="auto">
      <datalist id="meal-type-options">
        <option value="auto"><option value="breakfast"><option value="lunch"><option value="dinner"><option value="snacks">
      </datalist>
      <span class="hint">auto = pick from the time of day; or a custom type name</span>
    </div>
    <div class="field"><label>Quantity</label><input name="quantity" value="${esc(val(a.quantity) || '1')}" inputmode="decimal"></div>
    <div class="field"><label>Unit</label><input name="unit" value="${esc(val(a.unit) || 'serving')}"></div>
    <div class="field"><label>Quantity per € (off by default)</label><input name="quantity_from_amount_per_unit" value="${esc(val(a.quantity_from_amount?.per_unit))}" placeholder="e.g. 14.50 → €29 logs 2 servings"></div>
  </div>

  <div id="sec-meal" style="display:${a.log === 'meal' ? '' : 'none'}">
    <div class="field" style="max-width:420px"><label>Saved meal (typeahead searches SparkyFitness)</label>
      <input name="meal_template_id" id="meal_template_id" value="${esc(val(a.meal_template_id))}" placeholder="start typing a meal name…" autocomplete="off">
      <div class="tt" id="tt-meal"></div>
      <span class="hint">the dropdown fills the UUID for you</span>
    </div>
  </div>

  <div id="sec-food" style="display:${a.log === 'food' ? '' : 'none'}">
    <div class="field" style="max-width:420px"><label>Food (typeahead searches SparkyFitness)</label>
      <input name="food_id" id="food_id" value="${esc(val(a.food_id))}" placeholder="start typing a food name…" autocomplete="off" data-variant="variant_id">
      <div class="tt" id="tt-food"></div>
    </div>
    <div class="field" style="max-width:420px"><label>Variant (optional)</label>
      <input name="variant_id" id="variant_id" value="${esc(val(a.variant_id))}" placeholder="pick a variant from the dropdown, or paste a UUID">
    </div>
  </div>

  <div id="sec-foods" style="display:${a.log === 'foods' ? '' : 'none'}">
    <div id="food-items">${foodItems}</div>
    <div style="margin:.5rem 0"><button type="button" id="add-food-item" class="ghost">+ add food</button></div>
    <input type="hidden" name="foods_count" id="foods_count" value="${String(a.foods?.length ?? 0)}">
    <template id="food-item-template">${foodItemRow(0, '', '', 1, '', '', false, true)}</template>
  </div>

  <div class="field" style="max-width:560px;margin-top:.9rem"><label>Note template</label>
    <input name="note" value="${esc(val(a.note))}" placeholder="{{description}} – {{amount}} {{currency}}">
    <span class="hint">variables: description, amount, currency, category, destination, source, budget, date, time, tags, group_title</span>
  </div>

  <div class="row" style="margin-top:1rem">
    <label class="muted"><input type="checkbox" name="cont" ${v?.cont ? 'checked' : ''}> keep checking later rules after a match</label>
    ${v ? `<label class="muted"><input type="checkbox" name="enabled" ${v.enabled ? 'checked' : ''}> enabled</label>` : ''}
    <button type="submit">${v ? 'save changes' : 'create rule'}</button>
    <a class="btn ghost" href="/rules">cancel</a>
  </div>
</form>`,
    scripts: ruleFormJs(),
  });
}

function foodItemRow(
  i: number,
  foodId: string,
  variantId: string,
  quantity: number,
  unit: string,
  note: string,
  fixed: boolean,
  isTemplate = false,
): string {
  const n = isTemplate ? '__I__' : String(i);
  return `<div class="card" style="display:grid;grid-template-columns:1.4fr 1fr .6fr .6fr 1fr auto;gap:.5rem;align-items:end">
    <div class="field"><label>Food ${isTemplate ? '' : `#${i}`}</label>
      <input name="foods_${n}_food_id" value="${esc(foodId)}" placeholder="type to search…" autocomplete="off" data-food-item data-variant="foods_${n}_variant_id">
      <div class="tt" id="tt-food-${isTemplate ? '__I__' : i}"></div>
    </div>
    <div class="field"><label>Variant</label><input name="foods_${n}_variant_id" value="${esc(variantId)}" placeholder="optional"></div>
    <div class="field"><label>Qty</label><input name="foods_${n}_quantity" value="${String(quantity)}" inputmode="decimal"></div>
    <div class="field"><label>Unit</label><input name="foods_${n}_unit" value="${esc(unit)}"></div>
    <div class="field"><label>Note</label><input name="foods_${n}_note" value="${esc(note)}"></div>
    ${fixed && !isTemplate ? '' : `<button type="button" class="danger" data-remove-food-item ${isTemplate ? '' : ''}>✕</button>`}
  </div>`;
}

/** Shared client JS: log-type sections, foods rows, and the typeaheads. */
function ruleFormJs(): string {
  return `
// ---- "use" suggestions from the source transaction ----
document.querySelectorAll('[data-fill]').forEach((b) => b.addEventListener('click', () => {
  const el = document.getElementById('r-' + b.dataset.fill);
  if (el) { el.value = b.dataset.value; el.focus(); }
}));

// ---- toggle action sections ----
const logSel = document.getElementById('log');
function toggleSections() {
  const v = logSel.value;
  document.getElementById('sec-meal').style.display = v === 'meal' ? '' : 'none';
  document.getElementById('sec-food').style.display = v === 'food' ? '' : 'none';
  document.getElementById('sec-foods').style.display = v === 'foods' ? '' : 'none';
}
logSel.addEventListener('change', toggleSections);
toggleSections();

// ---- foods item rows ----
const tpl = document.getElementById('food-item-template');
const wrap = document.getElementById('food-items');
const count = document.getElementById('foods_count');
let nextIdx = parseInt(count.value || '0', 10);
document.getElementById('add-food-item').addEventListener('click', () => {
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelectorAll('[name]').forEach((inp) => { inp.name = inp.name.replace('__I__', String(nextIdx)); });
  const tt = node.querySelector('.tt');
  if (tt) tt.id = 'tt-food-' + nextIdx;
  node.querySelector('input[data-food-item]').dataset.variant = 'foods_' + nextIdx + '_variant_id';
  wrap.appendChild(node);
  count.value = String(++nextIdx);
  attachFoodTypeahead(node.querySelector('input[data-food-item]'));
});
wrap.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove-food-item]');
  if (!btn) return;
  const row = btn.closest('.card');
  if (!row) return;
  wrap.removeChild(row);
  let n = 0;
  for (const inp of wrap.querySelectorAll('input[name^="foods_"]')) {
    const m2 = inp.name.match(/^foods_(\\d+)_/);
    if (m2) n = Math.max(n, parseInt(m2[1], 10) + 1);
  }
  count.value = String(n);
  nextIdx = n;
});

// ---- typeaheads ----
async function fetchItems(kind, q) {
  const url = kind === 'meal' ? '/api/sparky/meals?q=' + encodeURIComponent(q) : '/api/sparky/foods?q=' + encodeURIComponent(q);
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  const arr = Array.isArray(data) ? data : (data && Array.isArray(data.data) ? data.data : []);
  return arr;
}
function renderItems(list, items, onPick) {
  list.innerHTML = '';
  if (!items.length) { list.innerHTML = '<span class="muted" style="padding:.35em .7em;display:block">no results</span>'; return; }
  for (const it of items.slice(0, 12)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = (it.name || '(unnamed)') + '  (' + it.id + ')';
    b.addEventListener('click', () => { onPick(it); list.innerHTML = ''; });
    list.appendChild(b);
    const variants = it.variants || (it.foods && it.foods.variants) || [];
    for (const v of variants.slice(0, 6)) {
      const vb = document.createElement('button');
      vb.type = 'button';
      vb.className = 'variant';
      vb.textContent = 'variant: ' + (v.name || v.id);
      vb.addEventListener('click', () => { onPick({ id: v.id, variantOf: it.id, variantId: v.id }); list.innerHTML = ''; });
      list.appendChild(vb);
    }
  }
}
function attachTypeahead(input, kind, listEl) {
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) { listEl.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      try {
        const items = await fetchItems(kind, q);
        renderItems(listEl, items, (pick) => {
          input.value = pick.id;
          if (pick.variantOf !== undefined && input.dataset.variant) {
            const vEl = document.getElementById(input.dataset.variant);
            if (vEl) vEl.value = pick.variantId ?? '';
          }
        });
      } catch { listEl.innerHTML = ''; }
    }, 250);
  });
  input.addEventListener('blur', () => setTimeout(() => { if (listEl) listEl.innerHTML = ''; }, 250));
}
function attachFoodTypeahead(input) {
  const listEl = input.closest('.field') ? input.closest('.field').querySelector('.tt') : null;
  if (listEl) attachTypeahead(input, 'food', listEl);
}
const mealInput = document.getElementById('meal_template_id');
if (mealInput) attachTypeahead(mealInput, 'meal', document.getElementById('tt-meal'));
const foodInput = document.getElementById('food_id');
if (foodInput) attachTypeahead(foodInput, 'food', document.getElementById('tt-food'));
wrap.querySelectorAll('input[data-food-item]').forEach(attachFoodTypeahead);
`;
}

function describeSplitLine(split: FireflySplit): string {
  const bits = [
    split.date,
    split.type,
    split.amount,
    split.currency_code,
    split.description ? `"${split.description}"` : '',
    split.source_name && split.destination_name ? `${split.source_name} → ${split.destination_name}` : split.destination_name ?? split.source_name ?? '',
    split.category_name ? `[${split.category_name}]` : '',
    split.tags.length ? `tags: ${split.tags.join(', ')}` : '',
  ].filter(Boolean);
  return bits.join(' · ');
}

// ------------------------------------------------------------------ //
// Event page: dry-run plan + activity log + actions
// ------------------------------------------------------------------ //

export function renderEventPage(opts: {
  event: EventRow;
  log: { level: string; message: string; created_at: string }[];
  plan: PlanLine[];
  hasTransactions: boolean;
  links: LinkRow[];
  /** The delivery's transactions, already formatted for display. */
  transactions?: { journal: string; date: string; type: string; description: string | null; amount: string; currency: string; source: string | null; destination: string | null; budget: string | null; category: string | null; tags: string[] }[];
}): string {
  const e = opts.event;
  const dash = '<span class="muted">—</span>';
  const txCards = (opts.transactions ?? [])
    .map(
      (t) => `<div class="card">
  <div class="row">
    <div><span>Date</span>${esc(t.date)}</div>
    <div><span>Description</span><strong>${t.description ? esc(t.description) : dash}</strong></div>
    <div><span>Amount</span>${esc(t.amount)} ${esc(t.currency)}</div>
    <div><span>From → to</span>${t.source ? esc(t.source) : dash} → ${t.destination ? esc(t.destination) : dash}</div>
    <div><span>Budget</span>${t.budget ? esc(t.budget) : dash}</div>
    <div><span>Category</span>${t.category ? esc(t.category) : dash}</div>
    ${t.tags.length ? `<div><span>Tags</span>${t.tags.map(esc).join(', ')}</div>` : ''}
    <div><span>Journal</span><span class="mono">${esc(t.journal)} · ${esc(t.type)}</span></div>
    ${opts.hasTransactions && e.trigger !== 'DESTROY_TRANSACTION' ? `<a class="btn" href="/rules/new?event=${e.id}&amp;split=${encodeURIComponent(t.journal)}">new rule from this transaction</a>` : ''}
  </div>
</div>`,
    )
    .join('\n');
  const planLines = opts.plan
    .map(
      (l) => `<div class="plan-line"><span class="badge ${
        l.kind === 'create' ? 'ok' : l.kind === 'delete' ? 'err' : l.kind === 'update' ? 'info' : 'warn'
      }">${l.kind}</span> <span class="mono">journal ${esc(l.journal)}</span> — ${esc(l.text)}</div>`,
    )
    .join('\n');
  const logLines = opts.log
    .map(
      (l) => `<div class="plan-line"><span class="muted">${esc(l.created_at.replace('T', ' ').slice(0, 19))}</span> <span class="badge ${l.level === 'error' ? 'err' : l.level === 'warn' ? 'warn' : 'info'}">${esc(l.level)}</span> ${esc(l.message)}</div>`,
    )
    .join('\n');
  const linkRows = opts.links
    .map(
      (l) => `<tr><td class="mono">${esc(l.journal_id)}</td><td class="mono">${esc(l.rule_id)}</td><td>${esc(l.kind)}</td><td class="mono">${l.sparky_entry_id ? esc(l.sparky_entry_id) : '<span class="muted">—</span>'}</td></tr>`,
    )
    .join('\n');

  return page({
    title: `Event ${e.id}`,
    active: 'dashboard',
    body: `
<h1>Event <span class="mono">#${e.id}</span> <span class="badge ${STATUS_CLASS[e.status] ?? 'muted'}">${esc(e.status)}</span>
</h1>
<div class="card row">
  <div><span>Trigger</span><span class="mono">${esc(e.trigger)}</span></div>
  <div><span>Received</span>${esc(e.created_at.replace('T', ' ').slice(0, 19))} UTC${e.attempts ? ` · ${e.attempts} attempt${e.attempts === 1 ? '' : 's'}` : ''}</div>
  <div><span>Result</span><span>${esc(e.result_summary ?? e.last_error ?? '—')}</span></div>
  <div class="actions">
    <a class="btn ghost" href="/">← dashboard</a>
    ${e.status === 'dead' ? `<form method="post" action="/events/${e.id}/retry"><button type="submit">retry (fresh budget)</button></form>` : ''}
  </div>
</div>

${txCards ? `<h2>Transaction${(opts.transactions ?? []).length === 1 ? '' : 's'}</h2>\n${txCards}` : ''}

<h2>What the current rules would do (live dry run — nothing is written)</h2>
<div class="card" style="padding:.25rem 1rem">${planLines || '<div class="plan-line muted">no splits in this delivery</div>'}</div>

${opts.links.length > 0 ? `<h2>Linked SparkyFitness entries</h2>
<div class="card table-wrap">
  <table>
    <thead><tr><th>Journal</th><th>Rule</th><th>Kind</th><th>Entry id</th></tr></thead>
    <tbody>${linkRows}</tbody>
  </table>
</div>` : ''}

<h2>Activity log</h2>
<div class="card" style="padding:.25rem 1rem">${logLines || '<div class="plan-line muted">no log entries</div>'}</div>`,
  });
}

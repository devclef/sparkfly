import type { AppConfig } from '../config.js';
import type { Db, EventStatus, LinkRow } from '../db/index.js';
import { journalIdOf, type FireflyPayload, type FireflySplit } from '../firefly/types.js';
import { fireflyPayloadSchema } from '../firefly/types.js';
import type { CompiledRule, CompiledRules } from '../rules/compile.js';
import type { RulesFile } from '../rules/types.js';
import { autoMealType, formatDateFromParts, formatTimeFromParts, toLocalParts } from '../rules/mealType.js';
import { describeSplit, matchedRules, type SplitContext } from '../rules/match.js';
import { renderTemplate } from '../rules/template.js';
import { SparkyError } from '../sparky/client.js';
import type { SparkyClient, SparkyEntryRef } from '../sparky/client.js';
import type { Logger } from 'pino';
import { RetryLater } from './queue.js';

/**
 * Turns one stored webhook event into SparkyFitness entries.
 *
 * STORE_TRANSACTION:   evaluate the rules for every split (journal) in the
 * group — first match wins unless `continue: true` — create the meal or food
 * entries and record journal → entry links.
 *
 * UPDATE_TRANSACTION:  re-evaluate the rules and reconcile the journal's
 * links: still-matching entries are updated in place, stale links are
 * deleted, newly matching rules create fresh entries.
 *
 * DESTROY_TRANSACTION: delete every entry linked to the journal.
 */
export interface ProcessorDeps {
  db: Db;
  cfg: AppConfig;
  /** null in dry-run mode (and when SPARKY_URL/KEY are absent). */
  sparky: SparkyClient | null;
  compiled: CompiledRules;
  logger: Logger;
}

export class EventProcessor {
  constructor(private readonly deps: ProcessorDeps) {}

  /**
   * Process one event. Throws RetryLater(delayMs) when the attempt failed and
   * another attempt should be made; otherwise finishes with the event in a
   * terminal status (succeeded / skipped / dead).
   */
  async process(eventId: number): Promise<void> {
    const { db } = this.deps;
    const event = db.getEvent(eventId);
    if (!event) return;
    if (event.status === 'succeeded' || event.status === 'skipped' || event.status === 'dead') {
      return; // nothing to do (also guards double-delivery races)
    }

    db.setEventStatus(eventId, 'processing');
    try {
      const payload = fireflyPayloadSchema.parse(JSON.parse(event.raw_json));
      const result = await this.dispatch(payload, eventId);
      db.setEventStatus(eventId, result.status, { resultSummary: result.summary });
      db.addLog(eventId, 'info', `${result.status}: ${result.summary}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = event.attempts + 1;
      const maxAttempts = this.deps.cfg.retry.maxAttempts;
      if (attempts >= maxAttempts) {
        db.setEventStatus(eventId, 'dead', { attempts, lastError: message });
        db.addLog(eventId, 'error', `giving up after ${attempts} attempts: ${message}`);
        this.deps.logger.error({ event: eventId, attempts, err: message }, 'event marked dead');
        return;
      }
      const delay = this.backoffDelay(attempts);
      db.setEventStatus(eventId, 'failed', { attempts, lastError: message });
      db.addLog(eventId, 'error', `attempt ${attempts}/${maxAttempts} failed: ${message}; retry in ${Math.round(delay / 1000)}s`);
      this.deps.logger.warn({ event: eventId, attempts, err: message, retryInMs: delay }, 'event attempt failed');
      throw new RetryLater(delay);
    }
  }

  /** Exponential backoff: base * 2^(attempt-1), capped, with jitter. */
  backoffDelay(attempts: number): number {
    const { baseDelayMs, maxDelayMs } = this.deps.cfg.retry;
    const delay = baseDelayMs * 2 ** (attempts - 1);
    const jitter = Math.floor(Math.random() * Math.max(1, baseDelayMs / 2));
    return Math.min(delay + jitter, maxDelayMs);
  }

  // ------------------------------------------------------------------ //

  private async dispatch(
    payload: FireflyPayload,
    eventId: number,
  ): Promise<{ status: EventStatus; summary: string }> {
    const trigger = payload.trigger;
    const prefix = this.deps.cfg.dryRun ? 'dry_run: ' : '';
    const splits = payload.content.transactions;

    if (trigger === 'STORE_TRANSACTION') {
      let logged = 0;
      const notes: string[] = [];
      for (const split of splits) {
        const outcome = await this.processSplit(split, payload, eventId);
        if (outcome === 'logged') logged += 1;
        else notes.push(outcome);
      }
      const summary = `${prefix}splits=${splits.length} logged=${logged}${notes.length ? ` (${notes.join('; ')})` : ''}`;
      return { status: 'succeeded', summary };
    }

    if (trigger === 'UPDATE_TRANSACTION') {
      let updated = 0;
      let created = 0;
      let deleted = 0;
      const notes: string[] = [];
      for (const split of splits) {
        const outcome = await this.processUpdate(split, payload, eventId);
        updated += outcome.updated;
        created += outcome.created;
        deleted += outcome.deleted;
        if (outcome.note) notes.push(outcome.note);
      }
      const summary =
        `${prefix}splits=${splits.length} updated=${updated} created=${created} deleted=${deleted}` +
        `${notes.length ? ` (${notes.join('; ')})` : ''}`;
      return { status: 'succeeded', summary };
    }

    if (trigger === 'DESTROY_TRANSACTION') {
      let deleted = 0;
      const notes: string[] = [];
      for (const split of splits) {
        const outcome = await this.processDestroy(split, eventId);
        deleted += outcome.deleted;
        if (outcome.note) notes.push(outcome.note);
      }
      const summary =
        `${prefix}splits=${splits.length} deleted=${deleted}${notes.length ? ` (${notes.join('; ')})` : ''}`;
      return { status: 'succeeded', summary };
    }

    const why = `unsupported trigger ${JSON.stringify(trigger)}`;
    this.deps.db.addLog(eventId, 'info', `skipped: ${why}`);
    return { status: 'skipped', summary: why };
  }

  private async processSplit(split: FireflySplit, payload: FireflyPayload, eventId: number): Promise<string> {
    const { db } = this.deps;
    const journalId = journalIdOf(split);
    const ctx = this.buildContext(split);
    const { hits, skipped } = this.matchRules(split, ctx, eventId);
    if (hits.length === 0) {
      if (!skipped) {
        db.addLog(eventId, 'info', `journal ${journalId}: no rule matched (${describeSplit(split)})`);
        return `journal ${journalId} no match`;
      }
      return `journal ${journalId} skipped (skip tag)`;
    }

    for (const rule of hits) {
      await this.createEntriesForRule(rule, ctx, payload, journalId, eventId);
    }
    return 'logged';
  }

  /**
   * Re-evaluate the rules for a journal whose transaction was edited and
   * reconcile the journal's links with the new result:
   *
   *  - link still matches a rule → update the entry in place
   *  - link no longer matches (including a newly added skip tag) → delete
   *  - rule's action type changed (meal ↔ food) → delete and re-create
   *  - rule newly matches → create a fresh entry
   */
  private async processUpdate(
    split: FireflySplit,
    payload: FireflyPayload,
    eventId: number,
  ): Promise<{ updated: number; created: number; deleted: number; note: string }> {
    const { db, cfg } = this.deps;
    const journalId = journalIdOf(split);
    const ctx = this.buildContext(split);
    const { hits } = this.matchRules(split, ctx, eventId);
    const targets = this.ruleTargets(hits);
    const existing = db.linksForJournal(journalId);

    if (cfg.dryRun) {
      const intents: string[] = [];
      for (const link of existing) {
        if (targets.has(link.rule_id)) {
          intents.push(`update ${link.kind} entry ${link.sparky_entry_id ?? '?'} (rule "${link.rule_id}")`);
        } else {
          intents.push(`delete ${link.kind} entry ${link.sparky_entry_id ?? '?'} (rule "${link.rule_id}" no longer matches)`);
        }
      }
      for (const id of targets.keys()) {
        if (!existing.some((l) => l.rule_id === id)) intents.push(`create entry for rule "${id}"`);
      }
      for (const intent of intents) {
        db.addLog(eventId, 'info', `dry run | journal ${journalId} | would ${intent}`);
      }
      return {
        updated: 0,
        created: 0,
        deleted: 0,
        note: intents.length === 0 ? `journal ${journalId} no changes` : `journal ${journalId} would change ×${intents.length}`,
      };
    }

    let updated = 0;
    let created = 0;
    let deleted = 0;

    for (const link of existing) {
      const target = targets.get(link.rule_id);
      if (!target) {
        await this.deleteEntry(link, journalId, eventId, 'rule no longer matches');
        deleted += 1;
      } else if (link.kind !== expectedKind(target.rule)) {
        // The rule's action type changed (meal ↔ food): the old entry is
        // stale, replace it.
        await this.deleteEntry(link, journalId, eventId, 'rule action changed');
        await this.createEntry(target.rule, target.item, ctx, payload, journalId, eventId);
        deleted += 1;
        created += 1;
      } else {
        await this.updateEntry(link, target.rule, target.item, ctx, payload, journalId, eventId);
        updated += 1;
      }
    }
    for (const [id, target] of targets) {
      if (!existing.some((l) => l.rule_id === id)) {
        await this.createEntriesForRule(target.rule, ctx, payload, journalId, eventId);
        created += (target.rule.action.log === 'foods' ? (target.rule.action.foods ?? []).length : 1);
      }
    }

    if (updated + created + deleted === 0) {
      db.addLog(eventId, 'info', `journal ${journalId}: nothing to do (${describeSplit(split)})`);
      return { updated: 0, created: 0, deleted: 0, note: `journal ${journalId} no changes` };
    }
    return { updated, created, deleted, note: '' };
  }

  /** Delete every entry linked to a destroyed transaction journal. */
  private async processDestroy(split: FireflySplit, eventId: number): Promise<{ deleted: number; note: string }> {
    const { db, cfg } = this.deps;
    const journalId = journalIdOf(split);
    const links = db.linksForJournal(journalId);

    if (cfg.dryRun) {
      for (const link of links) {
        db.addLog(eventId, 'info', `dry run | journal ${journalId} | would delete ${link.kind} entry ${link.sparky_entry_id ?? '?'} (rule "${link.rule_id}")`);
      }
      return {
        deleted: 0,
        note: links.length === 0 ? `journal ${journalId} no links` : `journal ${journalId} would delete ×${links.length}`,
      };
    }

    if (links.length === 0) {
      db.addLog(eventId, 'info', `journal ${journalId}: no linked entries — nothing to delete`);
      return { deleted: 0, note: `journal ${journalId} no links` };
    }
    let deleted = 0;
    for (const link of links) {
      await this.deleteEntry(link, journalId, eventId, 'transaction destroyed');
      deleted += 1;
    }
    return { deleted, note: '' };
  }

  /** Shared context (split + local wall-clock parts) for rule evaluation. */
  private buildContext(split: FireflySplit): SplitContext {
    return { split, local: toLocalParts(new Date(split.date), this.deps.cfg.tz) };
  }

  /**
   * Evaluate the rules for a split, honouring the global skip tag.
   * `skipped: true` means the skip tag was hit (already logged).
   */
  private matchRules(split: FireflySplit, ctx: SplitContext, eventId: number): { hits: CompiledRule[]; skipped: boolean } {
    const { db, compiled } = this.deps;
    const journalId = journalIdOf(split);
    const skipTag = compiled.defaults.global_skip_tag.toLowerCase();
    if (split.tags.some((t) => t.toLowerCase() === skipTag)) {
      db.addLog(eventId, 'info', `journal ${journalId}: skipped (has tag "${compiled.defaults.global_skip_tag}")`);
      return { hits: [], skipped: true };
    }
    return { hits: matchedRules(compiled.rules, ctx), skipped: false };
  }

  /**
   * The link ids a set of matched rules produces. `foods` rules log one
   * entry per item, so each item gets its own link id ("Rule#<i>"); meal
   * and food rules use the plain rule name.
   */
  private ruleTargets(hits: CompiledRule[]): Map<string, { rule: CompiledRule; item: number | null }> {
    const targets = new Map<string, { rule: CompiledRule; item: number | null }>();
    for (const rule of hits) {
      if (rule.action.log === 'foods') {
        (rule.action.foods ?? []).forEach((_, i) => targets.set(`${rule.name}#${i}`, { rule, item: i }));
      } else {
        targets.set(rule.name, { rule, item: null });
      }
    }
    return targets;
  }

  /**
   * Create all entries a matched rule produces: one for meal/food rules,
   * one per item for `foods` rules.
   */
  private async createEntriesForRule(
    rule: CompiledRule,
    ctx: SplitContext,
    payload: FireflyPayload,
    journalId: string,
    eventId: number,
  ): Promise<void> {
    if (rule.action.log === 'foods') {
      for (const [i] of (rule.action.foods ?? []).entries()) {
        await this.createEntry(rule, i, ctx, payload, journalId, eventId);
      }
      return;
    }
    await this.createEntry(rule, null, ctx, payload, journalId, eventId);
  }

  /**
   * Create the SparkyFitness entry for a matching rule (and, for `foods`
   * rules, for one item of it) and record the journal → entry link.
   */
  private async createEntry(
    rule: CompiledRule,
    itemIndex: number | null,
    ctx: SplitContext,
    payload: FireflyPayload,
    journalId: string,
    eventId: number,
  ): Promise<void> {
    const { db, cfg, compiled, sparky } = this.deps;
    const f = computeEntry(rule, itemIndex, ctx, payload, compiled.defaults);

    if (cfg.dryRun) {
      db.addLog(
        eventId,
        'info',
        `dry run | journal ${journalId} | rule "${f.linkId}" | would log ${describeAction(rule.action, f.mealType, f.quantity, f.entryDate, f.entryTime, f.omitTime)}`,
      );
      return;
    }
    if (!sparky) throw new Error('SparkyFitness client is not configured (is DRY_RUN stuck on?)');

    const common = this.entryBody(f);

    if (rule.action.log === 'meal') {
      // food-entry-meals has no idempotency key, so a retry must not create a
      // second entry for a journal that is already linked.
      const existing = db.linksForJournal(journalId).find((l) => l.rule_id === f.linkId && l.kind === 'meal');
      if (existing?.sparky_entry_id) {
        db.addLog(eventId, 'info', `journal ${journalId}: rule "${rule.name}" already linked to meal entry ${existing.sparky_entry_id}; not creating a duplicate`);
        return;
      }
      const ref = await sparky.logMeal({ ...common, meal_template_id: rule.action.meal_template_id as string });
      this.settle(f.linkId, 'meal', journalId, ref, eventId, `meal ${rule.action.meal_template_id}`);
      return;
    }

    if (rule.action.log === 'food') {
      const ref = await sparky.logFood({
        ...common,
        food_id: rule.action.food_id as string,
        variant_id: rule.action.variant_id,
        source: 'firefly',
        source_id: journalId,
      });
      this.settle(f.linkId, 'food', journalId, ref, eventId, `food ${rule.action.food_id}`);
      return;
    }

    // log: foods — the item index is part of the upsert key, which keeps the
    // item's entries distinct from each other.
    const item = rule.action.foods?.[itemIndex ?? -1];
    if (!item) throw new Error(`rule "${rule.name}": foods item ${String(itemIndex)} does not exist`);
    const ref = await sparky.logFood({
      ...common,
      food_id: item.food_id,
      variant_id: item.variant_id,
      source: 'firefly',
      source_id: `${journalId}:${itemIndex}`,
    });
    this.settle(f.linkId, 'food', journalId, ref, eventId, `foods[${itemIndex}] food ${item.food_id}`);
  }

  /**
   * Apply the rule's current result to an already-linked entry.
   *
   * Meals have no upsert key, so they are PUT in place (re-created when
   * SparkyFitness no longer knows the entry). Food entries are re-POSTed:
   * the (source, source_id) upsert key updates them in place and recreates
   * them if they were deleted on the SparkyFitness side.
   */
  private async updateEntry(
    link: LinkRow,
    rule: CompiledRule,
    itemIndex: number | null,
    ctx: SplitContext,
    payload: FireflyPayload,
    journalId: string,
    eventId: number,
  ): Promise<void> {
    const { db, cfg, compiled, sparky } = this.deps;
    const f = computeEntry(rule, itemIndex, ctx, payload, compiled.defaults);

    if (cfg.dryRun) {
      db.addLog(
        eventId,
        'info',
        `dry run | journal ${journalId} | rule "${f.linkId}" | would update ${link.kind} entry ${link.sparky_entry_id ?? '?'} to ${describeAction(rule.action, f.mealType, f.quantity, f.entryDate, f.entryTime, f.omitTime)}`,
      );
      return;
    }
    if (!sparky) throw new Error('SparkyFitness client is not configured (is DRY_RUN stuck on?)');

    const common = this.entryBody(f);

    if (link.kind === 'meal') {
      if (!link.sparky_entry_id) {
        // A meal link without an entry id cannot be updated in place; start
        // over (mirrors the STORE behaviour for that state).
        db.deleteLink(journalId, link.rule_id);
        await this.createEntry(rule, itemIndex, ctx, payload, journalId, eventId);
        return;
      }
      try {
        await sparky.updateMeal(link.sparky_entry_id, common);
      } catch (err) {
        if (!(err instanceof SparkyError && err.status === 404)) throw err;
        db.addLog(eventId, 'warn', `journal ${journalId}: meal entry ${link.sparky_entry_id} is gone on the SparkyFitness side; re-creating it`);
        db.deleteLink(journalId, link.rule_id);
        await this.createEntry(rule, itemIndex, ctx, payload, journalId, eventId);
        return;
      }
      db.upsertLink({ journalId, ruleId: link.rule_id, kind: 'meal', sparkyEntryId: link.sparky_entry_id, eventId });
      db.addLog(eventId, 'info', `journal ${journalId}: updated meal entry ${link.sparky_entry_id} via rule "${f.linkId}" (${f.entryDate}${f.omitTime ? '' : ` ${f.entryTime}`}, qty=${f.quantity})`);
      return;
    }

    // food / foods — re-POST through the idempotent upsert key.
    const item = itemIndex === null ? null : rule.action.foods?.[itemIndex];
    const ref = await sparky.logFood({
      ...common,
      food_id: (item?.food_id ?? rule.action.food_id) as string,
      variant_id: item?.variant_id ?? rule.action.variant_id,
      source: 'firefly',
      source_id: itemIndex === null ? journalId : `${journalId}:${itemIndex}`,
    });
    db.upsertLink({ journalId, ruleId: link.rule_id, kind: 'food', sparkyEntryId: ref.id ?? link.sparky_entry_id, eventId });
    db.addLog(eventId, 'info', `journal ${journalId}: updated food entry via rule "${f.linkId}" (${f.entryDate}${f.omitTime ? '' : ` ${f.entryTime}`}, qty=${f.quantity})`);
  }

  /**
   * Delete a linked entry on the SparkyFitness side and drop the link.
   * When the remote call fails the link is kept so a retry can try again.
   */
  private async deleteEntry(link: LinkRow, journalId: string, eventId: number, why: string): Promise<void> {
    const { db, sparky } = this.deps;
    if (!link.sparky_entry_id) {
      db.deleteLink(journalId, link.rule_id);
      db.addLog(eventId, 'info', `journal ${journalId}: dropped link for rule "${link.rule_id}" (no entry id recorded) — ${why}`);
      return;
    }
    if (!sparky) throw new Error('SparkyFitness client is not configured (is DRY_RUN stuck on?)');
    try {
      if (link.kind === 'meal') await sparky.deleteMeal(link.sparky_entry_id);
      else await sparky.deleteFood(link.sparky_entry_id);
    } catch (err) {
      if (!(err instanceof SparkyError && err.status === 404)) throw err;
      db.addLog(eventId, 'info', `journal ${journalId}: ${link.kind} entry ${link.sparky_entry_id} already gone on the SparkyFitness side — ${why}`);
      db.deleteLink(journalId, link.rule_id);
      return;
    }
    db.deleteLink(journalId, link.rule_id);
    db.addLog(eventId, 'info', `journal ${journalId}: deleted ${link.kind} entry ${link.sparky_entry_id} (rule "${link.rule_id}") — ${why}`);
  }

  /** The shared body fields for create/update calls. */
  private entryBody(f: EntryFields): {
    meal_type: string;
    entry_date: string;
    entry_time?: string;
    quantity: number;
    unit: string;
    notes?: string;
  } {
    return {
      meal_type: f.mealType,
      entry_date: f.entryDate,
      entry_time: f.omitTime ? undefined : f.entryTime,
      quantity: f.quantity,
      unit: f.unit,
      notes: f.note,
    };
  }

  private settle(ruleId: string, kind: 'meal' | 'food', journalId: string, ref: SparkyEntryRef, eventId: number, what: string): void {
    const { db } = this.deps;
    db.upsertLink({
      journalId,
      ruleId,
      kind,
      sparkyEntryId: ref.id,
      eventId,
    });
    db.addLog(eventId, 'info', `journal ${journalId}: logged ${what} via rule "${ruleId}" → entry ${ref.id ?? '(no id in response)'}`);
  }
}


/** Everything needed to write (create or update) one diary entry. */
interface EntryFields {
  rule: CompiledRule;
  /** Link id: the rule name, or "Rule#<item>" for multi-food rules. */
  linkId: string;
  mealType: string;
  quantity: number;
  unit: string;
  entryDate: string;
  entryTime: string;
  /** Midnight in Firefly means "no time was entered" — omit entry_time. */
  omitTime: boolean;
  note?: string;
}

/** The kind of link a rule's action produces. */
function expectedKind(rule: CompiledRule): 'meal' | 'food' {
  return rule.action.log === 'meal' ? 'meal' : 'food';
}

/**
 * Compute the diary-entry fields a rule (and, optionally, one of its foods
 * items) produces for this split.
 */
function computeEntry(
  rule: CompiledRule,
  itemIndex: number | null,
  ctx: SplitContext,
  payload: FireflyPayload,
  defaults: RulesFile['defaults'],
): EntryFields {
  const { split, local } = ctx;
  const action = rule.action;
  const item = itemIndex === null ? null : action.foods?.[itemIndex] ?? null;

  const mealType = action.meal_type === 'auto' ? autoMealType(local, defaults.meal_type_auto) : action.meal_type;
  const amountQuantity = action.quantity_from_amount
    ? Math.max(1, Math.round(Math.abs(Number(split.amount)) / action.quantity_from_amount.per_unit))
    : action.quantity;
  const quantity = item ? item.quantity : amountQuantity;
  const entryDate = formatDateFromParts(local);
  const entryTime = formatTimeFromParts(local);

  const vars: Record<string, string> = {
    description: split.description ?? '',
    amount: split.amount,
    currency: split.currency_code,
    category: split.category_name ?? '',
    destination: split.destination_name ?? '',
    source: split.source_name ?? '',
    budget: split.budget_name ?? '',
    date: entryDate,
    time: entryTime,
    tags: split.tags.join(', '),
    group_title: payload.content.group_title ?? '',
  };
  const note = item?.note
    ? renderTemplate(item.note, vars)
    : action.note
      ? renderTemplate(action.note, vars)
      : undefined;

  return {
    rule,
    linkId: itemIndex === null ? rule.name : `${rule.name}#${itemIndex}`,
    mealType,
    quantity,
    unit: item?.unit ?? action.unit,
    entryDate,
    entryTime,
    omitTime: entryTime === '00:00',
    note,
  };
}


function describeAction(
  action: { log: string; meal_template_id?: string; food_id?: string; foods?: { food_id: string }[] },
  mealType: string,
  quantity: number,
  entryDate: string,
  entryTime: string,
  omitTime: boolean,
): string {
  const target =
    action.log === 'meal' ? `meal ${action.meal_template_id}` :
    action.log === 'food' ? `food ${action.food_id}` :
    `foods [${(action.foods ?? []).map((f) => f.food_id).join(', ')}]`;
  return `${target} (meal_type=${mealType}, qty=${quantity}, ${entryDate}${omitTime ? '' : ` ${entryTime}`})`;
}


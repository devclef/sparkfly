import type { AppConfig } from '../config.js';
import type { Db, EventStatus } from '../db/index.js';
import { journalIdOf, type FireflyPayload, type FireflySplit } from '../firefly/types.js';
import { fireflyPayloadSchema } from '../firefly/types.js';
import type { CompiledRule, CompiledRules } from '../rules/compile.js';
import { autoMealType, formatDateFromParts, formatTimeFromParts, toLocalParts } from '../rules/mealType.js';
import { describeSplit, matchedRules, type SplitContext } from '../rules/match.js';
import { renderTemplate } from '../rules/template.js';
import type { SparkyClient, SparkyEntryRef } from '../sparky/client.js';
import type { Logger } from 'pino';
import { RetryLater } from './queue.js';

/**
 * Turns one stored webhook event into SparkyFitness entries.
 *
 * STORE_TRANSACTION: evaluate the rules for every split (journal) in the
 * group — first match wins unless `continue: true` — then create the meal or
 * food entries and record journal → entry links.
 *
 * UPDATE/DESTROY are recognised and explicitly skipped for now (milestone 2
 * will drive them through the links table).
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
    if (trigger === 'UPDATE_TRANSACTION' || trigger === 'DESTROY_TRANSACTION') {
      const why = `trigger ${trigger} is not handled yet (milestone 2: update/delete via the links table)`;
      this.deps.db.addLog(eventId, 'info', `skipped: ${why}`);
      return { status: 'skipped', summary: why };
    }
    if (trigger !== 'STORE_TRANSACTION') {
      const why = `unsupported trigger ${JSON.stringify(trigger)}`;
      this.deps.db.addLog(eventId, 'info', `skipped: ${why}`);
      return { status: 'skipped', summary: why };
    }

    const splits = payload.content.transactions;
    let logged = 0;
    const notes: string[] = [];
    for (const split of splits) {
      const outcome = await this.processSplit(split, payload, eventId);
      if (outcome === 'logged') logged += 1;
      else notes.push(outcome);
    }
    const prefix = this.deps.cfg.dryRun ? 'dry_run: ' : '';
    const summary = `${prefix}splits=${splits.length} logged=${logged}${notes.length ? ` (${notes.join('; ')})` : ''}`;
    return { status: 'succeeded', summary };
  }

  private async processSplit(split: FireflySplit, payload: FireflyPayload, eventId: number): Promise<string> {
    const { db, cfg, compiled } = this.deps;
    const journalId = journalIdOf(split);

    const skipTag = compiled.defaults.global_skip_tag.toLowerCase();
    if (split.tags.some((t) => t.toLowerCase() === skipTag)) {
      db.addLog(eventId, 'info', `journal ${journalId}: skipped (has tag "${compiled.defaults.global_skip_tag}")`);
      return `journal ${journalId} skipped (skip tag)`;
    }

    const date = new Date(split.date);
    const local = toLocalParts(date, cfg.tz);
    const ctx: SplitContext = { split, local };

    const hits = matchedRules(compiled.rules, ctx);
    if (hits.length === 0) {
      db.addLog(eventId, 'info', `journal ${journalId}: no rule matched (${describeSplit(split)})`);
      return `journal ${journalId} no match`;
    }

    for (const rule of hits) {
      await this.applyRule(rule, ctx, payload, journalId, eventId);
    }
    return 'logged';
  }

  private async applyRule(rule: CompiledRule, ctx: SplitContext, payload: FireflyPayload, journalId: string, eventId: number): Promise<void> {
    const { db, cfg, compiled, sparky } = this.deps;
    const { split, local } = ctx;
    const action = rule.action;

    const mealType = action.meal_type === 'auto' ? autoMealType(local, compiled.defaults.meal_type_auto) : action.meal_type;
    const quantity = action.quantity_from_amount
      ? Math.max(1, Math.round(Math.abs(Number(split.amount)) / action.quantity_from_amount.per_unit))
      : action.quantity;
    const entryDate = formatDateFromParts(local);
    const entryTime = formatTimeFromParts(local);
    // Firefly stores midnight as "no time was entered" — writing 00:00 into
    // the diary would be wrong, so drop entry_time in that case.
    const omitTime = entryTime === '00:00';

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

    if (cfg.dryRun) {
      db.addLog(eventId, 'info', `dry run | journal ${journalId} | rule "${rule.name}" | would log ${describeAction(action, mealType, quantity, entryDate, entryTime, omitTime)}`);
      return;
    }
    if (!sparky) throw new Error('SparkyFitness client is not configured (is DRY_RUN stuck on?)');

    const note = action.note ? renderTemplate(action.note, vars) : undefined;
    const common = {
      meal_type: mealType,
      entry_date: entryDate,
      entry_time: omitTime ? undefined : entryTime,
      quantity,
      unit: action.unit,
      notes: note,
    };

    if (action.log === 'meal') {
      // food-entry-meals has no idempotency key, so a retry must not create a
      // second entry for a journal that is already linked.
      const existing = db.linksForJournal(journalId).find((l) => l.rule_id === rule.name && l.kind === 'meal');
      if (existing?.sparky_entry_id) {
        db.addLog(eventId, 'info', `journal ${journalId}: rule "${rule.name}" already linked to meal entry ${existing.sparky_entry_id}; not creating a duplicate`);
        return;
      }
      const ref = await sparky.logMeal({ ...common, meal_template_id: action.meal_template_id as string });
      this.settle(rule.name, 'meal', journalId, ref, eventId, `meal ${action.meal_template_id}`);
      return;
    }

    if (action.log === 'food') {
      const ref = await sparky.logFood({
        ...common,
        food_id: action.food_id as string,
        variant_id: action.variant_id,
        source: 'firefly',
        source_id: journalId,
      });
      this.settle(rule.name, 'food', journalId, ref, eventId, `food ${action.food_id}`);
      return;
    }

    // log: foods — each item becomes its own food entry; the upsert key
    // distinguishes them by appending the item index to the journal id.
    for (const [i, item] of (action.foods ?? []).entries()) {
      const ref = await sparky.logFood({
        ...common,
        food_id: item.food_id,
        variant_id: item.variant_id,
        quantity: item.quantity,
        unit: item.unit ?? action.unit,
        notes: item.note ? renderTemplate(item.note, vars) : note,
        source: 'firefly',
        source_id: `${journalId}:${i}`,
      });
      this.settle(`${rule.name}#${i}`, 'food', journalId, ref, eventId, `foods[${i}] food ${item.food_id}`);
    }
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


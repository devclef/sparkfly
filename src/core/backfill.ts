import type { Db } from '../db/index.js';
import type { FireflyClient } from '../firefly/client.js';
import { journalIdOf, type FireflyPayload, type FireflySplit } from '../firefly/types.js';
import { BACKFILL_UUID_PREFIX, type EventProcessor } from './processEvent.js';
import type { EventQueue } from './queue.js';

/**
 * Backfill: run the rules over past Firefly transactions fetched through the
 * API (FIREFLY_URL + FIREFLY_PAT).
 *
 * Every transaction group that has at least one split matching a rule, and
 * no split already linked to a SparkyFitness entry, becomes a synthetic
 * STORE_TRANSACTION event with uuid "backfill-<group id>". From there it
 * goes through the normal queue, so retries, the activity log, the links
 * and later UPDATE/DESTROY webhooks all work as for live deliveries — and
 * running the same backfill twice is a no-op (the uuid is deduped).
 *
 * Groups that match nothing are not stored: a year of rent and groceries
 * would bury the dashboard.
 */

/** Hard cap on API pages per run (100 groups each). */
export const BACKFILL_MAX_PAGES = 50;

export type CandidateStatus = 'queue' | 'linked' | 'no-match' | 'skip-tag';

export interface BackfillCandidate {
  groupId: string;
  groupTitle: string | null;
  status: CandidateStatus;
  splits: { split: FireflySplit; rules: string[]; skipped: boolean; linked: boolean }[];
}

export interface BackfillScan {
  start: string;
  end: string;
  candidates: BackfillCandidate[];
  groups: number;
  invalidSplits: number;
  /** True when the date range had more pages than BACKFILL_MAX_PAGES. */
  truncated: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate a YYYY-MM-DD range. Returns an error message or null. */
export function checkRange(start: string, end: string): string | null {
  if (!DATE.test(start) || Number.isNaN(Date.parse(start))) return 'start must be a date (YYYY-MM-DD)';
  if (!DATE.test(end) || Number.isNaN(Date.parse(end))) return 'end must be a date (YYYY-MM-DD)';
  if (start > end) return 'start must not be after end';
  return null;
}

export async function scanBackfill(
  deps: { firefly: FireflyClient; processor: EventProcessor; db: Db },
  start: string,
  end: string,
  maxPages = BACKFILL_MAX_PAGES,
): Promise<BackfillScan> {
  const candidates: BackfillCandidate[] = [];
  let groups = 0;
  let invalidSplits = 0;
  let page = 1;
  let totalPages = 1;
  do {
    const res = await deps.firefly.transactionsPage(start, end, page);
    totalPages = res.totalPages;
    for (const g of res.groups) {
      groups += 1;
      invalidSplits += g.invalid;
      const splits = g.splits.map((split) => {
        const outcome = deps.processor.ruleOutcome(split);
        return {
          split,
          rules: outcome.rules,
          skipped: outcome.skipped,
          linked: deps.db.linksForJournal(journalIdOf(split)).length > 0,
        };
      });
      if (splits.length === 0) continue;
      const matched = splits.filter((s) => s.rules.length > 0);
      const status: CandidateStatus =
        splits.some((s) => s.linked) ? 'linked' :
        matched.length > 0 ? 'queue' :
        splits.every((s) => s.skipped) ? 'skip-tag' :
        'no-match';
      candidates.push({ groupId: g.id, groupTitle: g.groupTitle, status, splits });
    }
    page += 1;
  } while (page <= totalPages && page <= maxPages);
  return { start, end, candidates, groups, invalidSplits, truncated: totalPages > maxPages };
}

export function backfillPayload(c: BackfillCandidate): FireflyPayload {
  const numericId = Number(c.groupId);
  return {
    uuid: `${BACKFILL_UUID_PREFIX}${c.groupId}`,
    trigger: 'STORE_TRANSACTION',
    response: 'TRANSACTIONS',
    version: 'v1',
    content: {
      id: Number.isInteger(numericId) ? numericId : undefined,
      group_title: c.groupTitle,
      transactions: c.splits.map((s) => s.split),
    },
  };
}

/** Store and enqueue every `queue` candidate. */
export function queueBackfill(
  deps: { db: Db; queue: EventQueue },
  scan: BackfillScan,
): { queued: number; duplicates: number } {
  let queued = 0;
  let duplicates = 0;
  for (const c of scan.candidates) {
    if (c.status !== 'queue') continue;
    const payload = backfillPayload(c);
    const { id, duplicate } = deps.db.insertEvent({
      uuid: payload.uuid,
      trigger: payload.trigger,
      rawJson: JSON.stringify(payload),
    });
    if (duplicate) {
      duplicates += 1;
      continue;
    }
    deps.db.addLog(id, 'info', `backfill ${scan.start}…${scan.end}: queued Firefly transaction group ${c.groupId}`);
    deps.queue.enqueue(id);
    queued += 1;
  }
  return { queued, duplicates };
}

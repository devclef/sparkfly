import type { Logger } from 'pino';
import type { Db } from '../db/index.js';
import { compileRules, type CompiledRules } from './compile.js';
import { SETTING_IMPORTED_FROM, SETTING_MEAL_TYPE_AUTO, SETTING_SKIP_TAG } from './importFile.js';
import { DEFAULTS, rulesFileSchema, type RulesFile } from './types.js';

/**
 * The compiled rule set, loaded from the database and re-compiled whenever
 * the UI creates, edits or deletes a rule. The YAML file is only a
 * first-start import source; after that the database is the single source
 * of truth, so rule changes apply immediately without a restart.
 */
export class RulesRegistry {
  private current: CompiledRules;

  constructor(private readonly db: Db, private readonly logger: Logger) {
    this.current = this.load();
  }

  get compiled(): CompiledRules {
    return this.current;
  }

  get count(): number {
    return this.db.countRules();
  }

  /** Re-read the rules from the database. Returns the fresh compiled set. */
  reload(): CompiledRules {
    this.current = this.load();
    return this.current;
  }

  /** The file the rules were imported from on first start, if any. */
  get importedFrom(): string | null {
    return this.db.getSetting(SETTING_IMPORTED_FROM);
  }

  private load(): CompiledRules {
    const rules = this.db
      .listRules()
      .filter((r) => r.enabled === 1)
      .map((r) => ({
        name: r.name,
        'continue': r.cont === 1,
        match: JSON.parse(r.match_json),
        action: JSON.parse(r.action_json),
      }));
    const defaults = {
      meal_type_auto: JSON.parse(this.db.getSetting(SETTING_MEAL_TYPE_AUTO) ?? JSON.stringify(DEFAULTS.meal_type_auto)),
      global_skip_tag: this.db.getSetting(SETTING_SKIP_TAG) ?? DEFAULTS.global_skip_tag,
    };
    // Rules are validated before they are written (see rules/form.ts), but
    // keep the schema as a safety net for hand-edited databases.
    const file: RulesFile = rulesFileSchema.parse({ rules, defaults });
    try {
      return compileRules(file);
    } catch (err) {
      // A broken rule must not take the whole bridge down: log it loudly
      // and run with whatever compiles.
      this.logger.error({ err: (err as Error).message, ruleCount: rules.length }, 'failed to compile the stored rules');
      throw err;
    }
  }
}

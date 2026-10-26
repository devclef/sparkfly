import { existsSync } from 'node:fs';
import type { Logger } from 'pino';
import type { Db } from '../db/index.js';
import { loadRulesFile } from './load.js';

export const SETTING_IMPORTED_FROM = 'rules_imported_from';
export const SETTING_MEAL_TYPE_AUTO = 'defaults.meal_type_auto';
export const SETTING_SKIP_TAG = 'defaults.global_skip_tag';

/**
 * One-time import of the legacy YAML rules file into the database:
 *
 *  - only when the database has no rules yet AND no import was ever
 *    recorded (so a user who deletes all rules in the UI does not get the
 *    file re-imported on the next start);
 *  - a missing file is fine: the app simply starts with no rules.
 *
 * After the import the web UI is the source of truth and the file is
 * ignored.
 */
export function importRulesFileIfFirstTime(
  db: Db,
  filePath: string,
  logger: Logger,
): { imported: number; file: string | null } {
  if (db.countRules() > 0) return { imported: 0, file: db.getSetting(SETTING_IMPORTED_FROM) };
  if (db.getSetting(SETTING_IMPORTED_FROM) !== null) return { imported: 0, file: null };
  if (!existsSync(filePath)) return { imported: 0, file: null };

  const { file, loadedFrom } = loadRulesFile(filePath);
  db.withTransaction(() => {
    file.rules.forEach((r, i) =>
      db.insertRule({ name: r.name, match: r.match, action: r.action, cont: r['continue'], position: i + 1 }),
    );
    db.setSetting(SETTING_MEAL_TYPE_AUTO, JSON.stringify(file.defaults.meal_type_auto));
    db.setSetting(SETTING_SKIP_TAG, file.defaults.global_skip_tag);
    db.setSetting(SETTING_IMPORTED_FROM, loadedFrom ?? filePath);
  });
  logger.info(
    { rules: file.rules.length, file: loadedFrom },
    'imported rules from YAML file — the web UI is the source of truth from now on',
  );
  return { imported: file.rules.length, file: loadedFrom };
}

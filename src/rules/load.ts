import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { rulesFileSchema, type RulesFile } from './types.js';

export interface LoadedRules {
  file: RulesFile;
  /** null when the rules file did not exist (empty rule set). */
  loadedFrom: string | null;
}

/**
 * Read and validate the rules YAML file.
 * A missing file is not an error (the app runs with no rules); an invalid
 * file is, because a typo should not silently stop logging.
 */
export function loadRulesFile(filePath: string): LoadedRules {
  if (!existsSync(filePath)) {
    return { file: rulesFileSchema.parse({}), loadedFrom: null };
  }
  const raw = readFileSync(filePath, 'utf8');
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (err) {
    throw new Error(`failed to parse YAML at ${filePath}: ${(err as Error).message}`);
  }
  if (doc === undefined || doc === null) doc = {};
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`rules file at ${filePath} must be a YAML mapping with "rules:" and optional "defaults:"`);
  }

  const parsed = rulesFileSchema.safeParse(doc);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid rules file at ${filePath}:\n${details}`);
  }

  for (const rule of parsed.data.rules) {
    const a = rule.action;
    if (a.log === 'meal' && !a.meal_template_id) {
      throw new Error(`rule "${rule.name}": action.log is "meal" but action.meal_template_id is missing`);
    }
    if (a.log === 'food' && !a.food_id) {
      throw new Error(`rule "${rule.name}": action.log is "food" but action.food_id is missing`);
    }
    if (a.log === 'foods' && !a.foods?.length) {
      throw new Error(`rule "${rule.name}": action.log is "foods" but action.foods is missing or empty`);
    }
  }
  const seen = new Set<string>();
  for (const rule of parsed.data.rules) {
    if (seen.has(rule.name)) throw new Error(`duplicate rule name "${rule.name}" (names are used as rule ids)`);
    seen.add(rule.name);
  }

  return { file: parsed.data, loadedFrom: filePath };
}

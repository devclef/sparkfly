import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRulesFile } from '../src/rules/load.js';
import { compileRules } from '../src/rules/compile.js';

function writeFile(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sparkfly-rules-'));
  const p = path.join(dir, 'rules.yaml');
  writeFileSync(p, content);
  return p;
}

describe('loadRulesFile', () => {
  it('returns an empty ruleset when the file is missing', () => {
    const res = loadRulesFile('/nonexistent/path/rules.yaml');
    expect(res.loadedFrom).toBeNull();
    expect(res.file.rules).toEqual([]);
    expect(res.file.defaults.global_skip_tag).toBe('no-sparky');
  });

  it('loads and fills defaults', () => {
    const p = writeFile(
      [
        'rules:',
        '  - name: a',
        '    match: { destination: /x/i }',
        '    action: { log: food, food_id: f1, quantity: 2 }',
      ].join('\n'),
    );
    const res = loadRulesFile(p);
    expect(res.loadedFrom).toBe(p);
    expect(res.file.rules[0]!.action.unit).toBe('serving');
    expect(res.file.rules[0]!.action.meal_type).toBe('auto');
    expect(res.file.defaults.meal_type_auto.lunch).toBe('11:00-15:59');
  });

  it('rejects invalid YAML', () => {
    const p = writeFile('rules: [unclosed');
    expect(() => loadRulesFile(p)).toThrow(/failed to parse YAML/);
  });

  it('reports schema problems with paths', () => {
    const p = writeFile(['rules:', '  - name: a', '    match: { amount: { } }', '    action: { log: food, food_id: f1 }'].join('\n'));
    expect(() => loadRulesFile(p)).toThrow(/amount/);
  });

  it('enforces action/log consistency', () => {
    const p = writeFile(['rules:', '  - name: a', '    action: { log: meal }'].join('\n'));
    expect(() => loadRulesFile(p)).toThrow(/meal_template_id/);
  });

  it('rejects duplicate rule names', () => {
    const p = writeFile(
      [
        'rules:',
        '  - name: a',
        '    action: { log: food, food_id: f1 }',
        '  - name: a',
        '    action: { log: food, food_id: f2 }',
      ].join('\n'),
    );
    expect(() => loadRulesFile(p)).toThrow(/duplicate rule name/);
  });

  it('rejects top-level arrays', () => {
    const p = writeFile('- just\n- a\n- list\n');
    expect(() => loadRulesFile(p)).toThrow(/must be a YAML mapping/);
  });

  it('accepts an empty file', () => {
    const p = writeFile('');
    const res = loadRulesFile(p);
    expect(res.file.rules).toEqual([]);
  });
});

describe('compileRules', () => {
  it('fails fast on an invalid weekday', () => {
    const p = writeFile(['rules:', '  - name: a', '    match: { weekdays: [funday] }', '    action: { log: food, food_id: f1 }'].join('\n'));
    const { file } = loadRulesFile(p);
    expect(() => compileRules(file)).toThrow(/unknown weekday/);
  });
});

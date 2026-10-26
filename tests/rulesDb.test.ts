import { describe, expect, it } from 'vitest';
import { makeDb } from './helpers.js';

describe('rules table', () => {
  it('inserts, lists (ordered), updates and deletes rules', () => {
    const db = makeDb();
    const a = db.insertRule({ name: 'A', match: { destination: 'a' }, action: { log: 'food', food_id: 'fa' }, cont: false, position: 1 });
    const b = db.insertRule({ name: 'B', match: {}, action: { log: 'meal', meal_template_id: 'm1' }, cont: true, position: 2 });

    expect(db.countRules()).toBe(2);
    expect(db.listRules().map((r) => r.name)).toEqual(['A', 'B']);
    expect(db.findRuleByName('B')?.id).toBe(b);
    expect(db.getRule(a)!.cont).toBe(0);
    expect(db.getRule(b)!.cont).toBe(1);
    expect(JSON.parse(db.getRule(a)!.match_json)).toEqual({ destination: 'a' });

    expect(db.updateRule(a, { name: 'A2', match: { destination: 'a2' } })).toBe(true);
    expect(db.getRule(a)!.name).toBe('A2');
    expect(db.findRuleByName('A')).toBeNull();
    expect(JSON.parse(db.getRule(a)!.match_json)).toEqual({ destination: 'a2' });

    expect(db.updateRule(a, { cont: true })).toBe(true);
    expect(db.getRule(a)!.cont).toBe(1);

    expect(db.deleteRule(a)).toBe(true);
    expect(db.deleteRule(a)).toBe(false);
    expect(db.countRules()).toBe(1);
    db.close();
  });

  it('moves rules by swapping positions', () => {
    const db = makeDb();
    const a = db.insertRule({ name: 'A', match: {}, action: { log: 'food', food_id: '1' }, cont: false, position: 1 });
    const b = db.insertRule({ name: 'B', match: {}, action: { log: 'food', food_id: '2' }, cont: false, position: 2 });
    const c = db.insertRule({ name: 'C', match: {}, action: { log: 'food', food_id: '3' }, cont: false, position: 3 });

    expect(db.moveRule(b, -1)).toBe(true); // B goes before A
    expect(db.listRules().map((r) => r.name)).toEqual(['B', 'A', 'C']);
    expect(db.moveRule(c, 1)).toBe(false); // already last
    expect(db.moveRule(b, 1)).toBe(true);  // B back down
    expect(db.listRules().map((r) => r.name)).toEqual(['A', 'B', 'C']);
    db.close();
    void a;
  });

  it('stores settings as key/value and runs transactions', () => {
    const db = makeDb();
    expect(db.getSetting('x')).toBeNull();
    db.setSetting('x', '1');
    db.setSetting('x', '2');
    expect(db.getSetting('x')).toBe('2');
    expect(db.countRules()).toBe(0);
    db.withTransaction(() => {
      db.insertRule({ name: 'in-tx', match: {}, action: { log: 'food', food_id: '1' }, cont: false, position: 1 });
      throw new Error('abort');
    });
    // The transaction rolled back.
    expect(db.countRules()).toBe(0);
    db.close();
  });
});

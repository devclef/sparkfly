import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../src/rules/template.js';

const vars = {
  description: 'Indian Garden',
  amount: '14.50',
  currency: 'EUR',
  category: 'Eating out',
  destination: 'Indian Garden',
  source: 'Checking',
  budget: 'Food',
  date: '2026-10-25',
  time: '12:41',
  tags: 'lunch, takeout',
  group_title: '',
};

describe('renderTemplate', () => {
  it('substitutes known variables', () => {
    expect(renderTemplate('{{description}} – {{amount}} {{currency}}', vars)).toBe('Indian Garden – 14.50 EUR');
  });
  it('renders unknown variables as empty strings', () => {
    expect(renderTemplate('{{nope}} and {{amount}}', vars)).toBe(' and 14.50');
  });
  it('allows whitespace inside braces', () => {
    expect(renderTemplate('{{ amount }}', vars)).toBe('14.50');
  });
  it('leaves plain text untouched', () => {
    expect(renderTemplate('no variables here', vars)).toBe('no variables here');
  });
  it('repeats variables', () => {
    expect(renderTemplate('{{currency}} {{currency}}', vars)).toBe('EUR EUR');
  });
});

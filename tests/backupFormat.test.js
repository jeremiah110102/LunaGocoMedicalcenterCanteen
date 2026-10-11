import { describe, it, expect } from 'vitest';
import { serializeDoc, deserializeRow, validateWorkbook, cellToValue, BACKUP_APP_ID } from '../src/lib/backupFormat';

const meta = [
  { key: 'app', value: BACKUP_APP_ID },
  { key: 'version', value: 1 },
];

describe('serialize / deserialize', () => {
  it('round-trips dates and JSON fields', () => {
    const ts = { toDate: () => new Date('2026-10-10T08:00:00.000Z') };
    const row = serializeDoc('p1', { name: 'Rice', price: 60, recipe: [{ ingredientId: 'a', qty: 1 }], createdAt: ts });
    expect(row).toEqual({ id: 'p1', name: 'Rice', price: 60, recipe: '[{"ingredientId":"a","qty":1}]', createdAt: '2026-10-10T08:00:00.000Z' });
    const back = deserializeRow('products', row);
    expect(back.errors).toEqual([]);
    expect(back.data.recipe).toEqual([{ ingredientId: 'a', qty: 1 }]);
    expect(back.data.createdAt).toBeInstanceOf(Date);
  });
  it('reads ExcelJS rich text and formulas', () => {
    expect(cellToValue({ richText: [{ text: 'a' }, { text: 'b' }] })).toBe('ab');
    expect(cellToValue({ formula: 'A1', result: 5 })).toBe(5);
  });
});

describe('validateWorkbook', () => {
  it('rejects files that are not backups', () => {
    expect(validateWorkbook({ Sheet1: [{ a: 1 }] }).ok).toBe(false);
  });
  it('accepts a valid backup and ignores unknown sheets', () => {
    const r = validateWorkbook({ _meta: meta, categories: [{ id: 'c1', name: 'Drinks' }], Notes: [] });
    expect(r.ok).toBe(true);
    expect(r.counts.categories).toBe(1);
    expect(r.warnings).toHaveLength(1);
  });
  it('reports missing ids, bad JSON, bad dates and duplicates', () => {
    const r = validateWorkbook({
      _meta: meta,
      products: [
        { id: '', name: 'x' },
        { id: 'p1', recipe: '{oops' },
        { id: 'p2', createdAt: 'not a date' },
        { id: 'p3' },
        { id: 'p3' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(4);
  });
  it('refuses a staff sheet with no active admin', () => {
    const r = validateWorkbook({ _meta: meta, staff: [{ id: 's1', role: 'cashier' }, { id: 's2', role: 'admin', active: false }] });
    expect(r.ok).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { buildTables, toCell } from '../src/services/sheetsCopy';

describe('Google Sheets copy', () => {
  it('never copies PIN hashes, and keeps formulas as text', () => {
    const tables = buildTables({ staff: [{ id: 's1', data: { name: 'Ana', role: 'admin', pinHash: 'x', pinSalt: 'y' } }], sales: [{ id: 'r', data: { note: '=HYPERLINK("x")', createdAt: { toDate: () => new Date('2026-10-11T00:00:00Z') } } }] });
    const staff = tables.find((t) => t.name === 'Staff');
    expect(staff.headers).toEqual(['id', 'name', 'role']);
    const sales = tables.find((t) => t.name === 'Sales');
    expect(sales.rows[0]).toEqual(['r', '2026-10-11T00:00:00.000Z', "'=HYPERLINK(\"x\")"]);
    expect(toCell({ a: 1 })).toBe('{"a":1}');
  });
});

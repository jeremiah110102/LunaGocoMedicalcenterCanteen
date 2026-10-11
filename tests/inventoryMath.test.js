import { describe, it, expect } from 'vitest';
import { countVariances, daysLeft, expiringSoon, deliveryBalance, payableStatus, allocateOldestFirst, addDays } from '../src/lib/inventoryMath';

describe('stock count variances', () => {
  it('values shortages and overages; skips items not counted', () => {
    const v = countVariances([
      { name: 'Coke', expected: 24, counted: 20, cost: 18 },
      { name: 'Rice', expected: 10, counted: '10.5', cost: 50 },
      { name: 'Egg', expected: 30, counted: null, cost: 8 },
    ]);
    expect([v.counted, v.notCounted, v.changed, v.shortValue, v.overValue, v.netValue]).toEqual([2, 1, 2, -72, 25, -47]);
  });
});

describe('expiry', () => {
  const today = new Date(2026, 9, 11);
  it('counts days to expiry', () => {
    expect(daysLeft('2026-10-11', today)).toBe(0);
    expect(daysLeft('2026-10-18', today)).toBe(7);
    expect(daysLeft('2026-10-09', today)).toBe(-2);
  });
  it('lists open batches expiring soon, soonest first', () => {
    const list = expiringSoon([
      { id: 'a', expiryDate: '2026-10-20', status: 'open' },
      { id: 'b', expiryDate: '2026-10-12', status: 'open' },
      { id: 'c', expiryDate: '2026-10-10', status: 'closed' },
      { id: 'd', expiryDate: '2026-10-09', status: 'open' },
    ], 7, today);
    expect(list.map((b) => b.id)).toEqual(['d', 'b']);
  });
});

describe('supplier payables', () => {
  const today = new Date(2026, 9, 11);
  const dels = [
    { id: '1', deliveryNo: 'DR-000001', total: 500, paidAmount: 200, dueDate: '2026-10-01' },
    { id: '2', deliveryNo: 'DR-000002', total: 300, dueDate: '2026-10-13' },
    { id: '3', deliveryNo: 'DR-000003', total: 100, paidAmount: 100, dueDate: '2026-09-01' },
  ];
  it('balances and status', () => {
    expect(deliveryBalance(dels[0])).toBe(300);
    expect(dels.map((d) => payableStatus(d, today))).toEqual(['overdue', 'due-soon', 'paid']);
    expect(addDays(new Date(2026, 9, 11), 30)).toBe('2026-11-10');
  });
  it('pays the oldest first', () => {
    expect(allocateOldestFirst(400, dels)).toEqual({
      allocations: [{ deliveryId: '1', deliveryNo: 'DR-000001', amount: 300 }, { deliveryId: '2', deliveryNo: 'DR-000002', amount: 100 }],
      leftover: 0,
    });
    expect(allocateOldestFirst(1000, dels).leftover).toBe(400);
  });
});

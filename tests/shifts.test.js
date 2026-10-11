import { describe, it, expect } from 'vitest';
import { countTotal, summarizeShift, cashDifference } from '../src/lib/shifts';

describe('shift cash', () => {
  it('counts bills and coins', () => {
    expect(countTotal({ 1000: 1, 100: 3, 20: 2, 1: 7, 0.25: 4 })).toBe(1348);
  });
  it('expected cash = opening + cash sales + cash repayments + pay-ins − pay-outs − cash refunds', () => {
    const s = summarizeShift({
      openingCash: 500,
      sales: [{ paymentMethod: 'cash', total: 120, discount: 0 }, { paymentMethod: 'gcash', total: 60 }, { paymentMethod: 'credit', total: 45 }, { paymentMethod: 'cash', total: 85.5, discount: 9.5 }],
      refunds: [{ amount: 30, cashAmount: 30 }, { amount: 40, cashAmount: 10, gcashAmount: 0 }],
      payments: [{ method: 'cash', amount: 100 }, { method: 'gcash', amount: 50 }],
      cashEvents: [{ type: 'in', amount: 200 }, { type: 'out', amount: 150 }],
    });
    expect(s.cashSales).toBe(205.5);
    expect(s.grossSales).toBe(310.5);
    expect(s.expectedCash).toBe(500 + 205.5 + 100 + 200 - 150 - 40);
    expect([s.salesCount, s.refundTotal, s.discounts]).toEqual([4, 70, 9.5]);
  });
  it('over and short', () => {
    expect(cashDifference(810, 815.5)).toBe(-5.5);
    expect(cashDifference(820, 815.5)).toBe(4.5);
  });
});

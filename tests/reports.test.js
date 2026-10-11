import { describe, it, expect } from 'vitest';
import { summarizeSales, summarizeMovements } from '../src/lib/reports';

const sales = [
  { total: 108, discount: 12, paymentMethod: 'cash', cashierId: 'a', cashierName: 'Ana', createdAt: new Date('2026-10-09T10:00'), items: [{ productId: 'r', name: 'Rice meal', qty: 2, price: 60, cost: 35, lineTotal: 120 }] },
  { total: 25, discount: 0, paymentMethod: 'credit', cashierId: 'b', cashierName: 'Ben', createdAt: new Date('2026-10-10T10:00'), items: [{ productId: 'c', name: 'Coke', qty: 1, price: 25, cost: 18, lineTotal: 25 }] },
];

describe('summarizeSales', () => {
  const s = summarizeSales(sales, { from: new Date('2026-10-08T00:00'), to: new Date('2026-10-10T23:59') });
  it('totals', () => expect([s.total, s.count, s.discount, s.cost, s.grossProfit]).toEqual([133, 2, 12, 88, 45]));
  it('best sellers first', () => expect(s.products[0].name).toBe('Rice meal'));
  it('fills empty days', () => expect(s.days.map((d) => d.total)).toEqual([0, 108, 25]));
  it('splits by method and cashier', () => {
    expect(s.byMethod.credit.total).toBe(25);
    expect(s.cashiers[0].name).toBe('Ana');
  });
});

describe('summarizeMovements', () => {
  it('separates consumption from waste', () => {
    const r = summarizeMovements([
      { itemType: 'ingredient', itemId: 'x', itemName: 'Chicken', change: -0.3, reason: 'sale' },
      { itemType: 'ingredient', itemId: 'x', itemName: 'Chicken', change: -0.5, reason: 'spoiled' },
      { itemType: 'ingredient', itemId: 'x', itemName: 'Chicken', change: 5, reason: 'receive' },
    ]);
    expect(r[0]).toMatchObject({ used: 0.3, wasted: 0.5, received: 5 });
  });
});

import { profitAndLoss } from '../src/lib/reports';
describe('profit and loss', () => {
  it('nets refunds, cost of goods, waste, count losses and expenses', () => {
    const p = profitAndLoss({
      sales: [{ total: 200, items: [{ cost: 30, qty: 2 }, { cost: 18, qty: 1 }] }],
      refunds: [{ amount: 25, restocked: true, lines: [{ cost: 18, qty: 1 }] }],
      movements: [{ reason: 'spoiled', change: -2, itemType: 'ingredient', itemId: 'egg' }, { reason: 'count', change: -1, itemType: 'product', itemId: 'coke' }, { reason: 'count', change: 2, itemType: 'ingredient', itemId: 'egg' }, { reason: 'sale', change: -5, itemType: 'product', itemId: 'coke' }],
      expenses: [{ amount: 40, category: 'Gas / LPG' }, { amount: 99, category: 'Other', voided: true }],
      costOf: (t, id) => ({ egg: 8, coke: 18 }[id] || 0),
    });
    expect([p.netSales, p.cogs, p.grossProfit, p.waste, p.countLoss, p.expenseTotal, p.netProfit]).toEqual([175, 60, 115, 16, 2, 40, 57]);
    expect(p.byCategory).toEqual({ 'Gas / LPG': 40 });
  });
});

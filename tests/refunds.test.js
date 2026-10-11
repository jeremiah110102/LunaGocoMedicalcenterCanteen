import { describe, it, expect } from 'vitest';
import { computeRefund, refundSplit, refundableQty } from '../src/lib/refunds';

const sale = {
  items: [{ productId: 'a', name: 'Adobo', price: 60, qty: 2 }, { productId: 'c', name: 'Coke', price: 25, qty: 1 }],
  subtotal: 145, discount: 14.5, total: 130.5, refundedTotal: 0,
};

describe('refunds', () => {
  it('shares the discount proportionally', () => {
    const r = computeRefund(sale, { 1: 1 });
    expect([r.gross, r.amount, r.full]).toEqual([25, 22.5, false]);
  });
  it('the last refund returns exactly what is left', () => {
    const after = { ...sale, refundedQty: { 1: 1 }, refundedTotal: 22.5 };
    const r = computeRefund(after, { 0: 2 });
    expect([r.amount, r.full]).toEqual([108, true]);
    expect(refundableQty(after)).toEqual([2, 0]);
  });
  it('a full void returns the whole total', () => {
    expect(computeRefund(sale, { 0: 2, 1: 1 }).amount).toBe(130.5);
  });
  it('blocks refunding more than was sold or nothing at all', () => {
    expect(computeRefund(sale, { 1: 2 }).error).toMatch(/only 1/);
    expect(computeRefund(sale, {}).error).toMatch(/at least one/);
    expect(computeRefund({ ...sale, refundedQty: { 1: 1 } }, { 1: 1 }).error).toMatch(/only 0/);
  });
  it('credit refunds lower the balance, the rest back in cash', () => {
    expect(refundSplit('credit', 100, 30)).toEqual({ creditAmount: 30, cashAmount: 70, gcashAmount: 0 });
    expect(refundSplit('cash', 50)).toEqual({ creditAmount: 0, cashAmount: 50, gcashAmount: 0 });
    expect(refundSplit('gcash', 50).gcashAmount).toBe(50);
  });
});

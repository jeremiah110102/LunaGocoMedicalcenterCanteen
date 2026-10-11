import { round2 } from './checkout';

// Philippine peso bills and coins for counting the drawer
export const DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 1, 0.25];

export const countTotal = (counts = {}) =>
  round2(DENOMINATIONS.reduce((t, d) => t + d * (Number(counts[d]) || 0), 0));

/**
 * What should be in the drawer at the end of a shift.
 *  sales: sales rung up in the shift · refunds: refunds paid out in the shift
 *  payments: credit repayments taken in the shift · cashEvents: pay-ins / pay-outs
 */
export function summarizeShift({ openingCash = 0, sales = [], refunds = [], payments = [], cashEvents = [] }) {
  const by = (m) => sales.filter((s) => s.paymentMethod === m);
  const sum = (list, f) => round2(list.reduce((t, x) => t + (Number(f(x)) || 0), 0));
  const cashSales = sum(by('cash'), (s) => s.total);
  const gcashSales = sum(by('gcash'), (s) => s.total);
  const creditSales = sum(by('credit'), (s) => s.total);
  const cashRefunds = sum(refunds, (r) => r.cashAmount);
  const gcashRefunds = sum(refunds, (r) => r.gcashAmount);
  const cashRepayments = sum(payments.filter((p) => p.method === 'cash'), (p) => p.amount);
  const gcashRepayments = sum(payments.filter((p) => p.method === 'gcash'), (p) => p.amount);
  const payIns = sum(cashEvents.filter((e) => e.type === 'in'), (e) => e.amount);
  const payOuts = sum(cashEvents.filter((e) => e.type === 'out'), (e) => e.amount);
  const expectedCash = round2(Number(openingCash) + cashSales + cashRepayments + payIns - payOuts - cashRefunds);
  return {
    salesCount: sales.length,
    grossSales: round2(cashSales + gcashSales + creditSales),
    cashSales, gcashSales, creditSales,
    discounts: sum(sales, (s) => s.discount),
    refundCount: refunds.length,
    refundTotal: sum(refunds, (r) => r.amount),
    cashRefunds, gcashRefunds,
    cashRepayments, gcashRepayments,
    payIns, payOuts,
    openingCash: round2(Number(openingCash)),
    expectedCash,
  };
}

/** Over (+) or short (−) amount after counting. */
export const cashDifference = (counted, expected) => round2(Number(counted) - Number(expected));

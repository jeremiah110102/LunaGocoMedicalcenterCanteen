import { round2 } from './checkout';
import { dayKey } from './format';

/** Summarises a list of sales. Pure, so it is easy to test and reuse. */
export function summarizeSales(sales, { from, to } = {}) {
  const total = round2(sales.reduce((t, s) => t + (Number(s.total) || 0), 0));
  const discount = round2(sales.reduce((t, s) => t + (Number(s.discount) || 0), 0));
  const cost = round2(sales.reduce((t, s) => t + (s.items || []).reduce((c, i) => c + (Number(i.cost) || 0) * Number(i.qty), 0), 0));

  const byMethod = {};
  const byCashier = {};
  const byProduct = {};
  const byDay = {};

  for (const s of sales) {
    const m = (byMethod[s.paymentMethod] ||= { count: 0, total: 0 });
    m.count += 1;
    m.total = round2(m.total + Number(s.total));

    const c = (byCashier[s.cashierId] ||= { name: s.cashierName, count: 0, total: 0 });
    c.count += 1;
    c.total = round2(c.total + Number(s.total));

    const d = (byDay[dayKey(s.createdAt)] ||= { count: 0, total: 0 });
    d.count += 1;
    d.total = round2(d.total + Number(s.total));

    for (const i of s.items || []) {
      const p = (byProduct[i.productId] ||= { name: i.name, qty: 0, revenue: 0 });
      p.qty += Number(i.qty);
      p.revenue = round2(p.revenue + Number(i.lineTotal ?? i.price * i.qty));
    }
  }

  // Fill empty days so the trend chart shows gaps.
  if (from && to) {
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      byDay[dayKey(d)] ||= { count: 0, total: 0 };
    }
  }

  return {
    count: sales.length,
    total,
    discount,
    cost,
    grossProfit: round2(total - cost),
    average: sales.length ? round2(total / sales.length) : 0,
    byMethod,
    cashiers: Object.values(byCashier).sort((a, b) => b.total - a.total),
    products: Object.values(byProduct).sort((a, b) => b.qty - a.qty),
    days: Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({ day, ...v })),
  };
}

/** Totals ingredient use from stock movements: sales consumption vs waste. */
export function summarizeMovements(movements) {
  const out = {};
  for (const m of movements) {
    const r = (out[`${m.itemType}:${m.itemId}`] ||= { name: m.itemName, itemId: m.itemId, itemType: m.itemType, used: 0, wasted: 0, received: 0, adjusted: 0 });
    const ch = Number(m.change) || 0;
    if (m.reason === 'sale') r.used = round2(r.used - ch);
    else if (['spoiled', 'expired', 'wasted'].includes(m.reason)) r.wasted = round2(r.wasted - ch);
    else if (m.reason === 'receive' || m.reason === 'initial') r.received = round2(r.received + ch);
    else r.adjusted = round2(r.adjusted + ch);
  }
  return Object.values(out).sort((a, b) => b.used + b.wasted - (a.used + a.wasted));
}

/**
 * Profit and loss for a period.
 *  sales, refunds: in the period · movements: stock movements in the period
 *  costOf(itemType, itemId): current unit cost · expenses: non-voided expenses in the period
 */
export function profitAndLoss({ sales = [], refunds = [], movements = [], expenses = [], costOf = () => 0 }) {
  const grossSales = round2(sales.reduce((t, s) => t + (Number(s.total) || 0), 0));
  const refundTotal = round2(refunds.reduce((t, r) => t + (Number(r.amount) || 0), 0));
  const netSales = round2(grossSales - refundTotal);
  const salesCost = round2(sales.reduce((t, s) => t + (s.items || []).reduce((c, i) => c + (Number(i.cost) || 0) * Number(i.qty), 0), 0));
  const returnedCost = round2(refunds.filter((r) => r.restocked).reduce((t, r) => t + (r.lines || []).reduce((c, l) => c + (Number(l.cost) || 0) * Number(l.qty), 0), 0));
  const cogs = round2(salesCost - returnedCost);
  const valueOf = (m) => round2(-(Number(m.change) || 0) * costOf(m.itemType, m.itemId));
  const waste = round2(movements.filter((m) => ['spoiled', 'expired', 'wasted'].includes(m.reason)).reduce((t, m) => t + valueOf(m), 0));
  const countLoss = round2(movements.filter((m) => m.reason === 'count').reduce((t, m) => t + valueOf(m), 0));
  const live = expenses.filter((e) => !e.voided);
  const expenseTotal = round2(live.reduce((t, e) => t + (Number(e.amount) || 0), 0));
  const byCategory = live.reduce((m, e) => ({ ...m, [e.category]: round2((m[e.category] || 0) + Number(e.amount)) }), {});
  const grossProfit = round2(netSales - cogs);
  const netProfit = round2(grossProfit - waste - countLoss - expenseTotal);
  return {
    grossSales, refundTotal, netSales, cogs, grossProfit, waste, countLoss, expenseTotal, byCategory, netProfit,
    margin: netSales ? round2((netProfit / netSales) * 100) : 0,
  };
}

// Accounting view of the canteen: sales book, money in / money out by payment method,
// receivables (credit), payables (suppliers), cash drawer over/short and a journal.
// Pure, so it is easy to test and reuse in the Excel export.
import { round2 } from './checkout';
import { dayKey, toDate } from './format';
import { deliveryBalance, payableStatus } from './inventoryMath';
import { profitAndLoss } from './reports';

export const MONEY_METHODS = { cash: 'Cash', gcash: 'GCash', bank: 'Bank transfer', check: 'Check' };

const num = (v) => Number(v) || 0;
const sum = (list, f) => round2(list.reduce((t, x) => t + num(f(x)), 0));
const monthKey = (v) => dayKey(v).slice(0, 7);
const time = (v) => toDate(v)?.getTime() || 0;

/** Sales book rows, one per day (or month): what an accountant copies into the books. */
export function salesBook({ sales = [], refunds = [], payments = [], expenses = [], supplierPayments = [], from, to, by = 'day' }) {
  const keyOf = by === 'month' ? monthKey : dayKey;
  const rows = {};
  const row = (k) => (rows[k] ||= {
    period: k, receipts: 0, firstReceipt: '', lastReceipt: '', beforeDiscount: 0, discounts: 0, refunds: 0, netSales: 0,
    cash: 0, gcash: 0, credit: 0, collections: 0, expenses: 0, supplierPaid: 0,
  });

  // Empty days/months too, so the book has no gaps.
  if (from && to) {
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) row(keyOf(d));
  }
  for (const s of sales) {
    const r = row(keyOf(s.createdAt));
    r.receipts += 1;
    if (s.receiptNo) {
      if (!r.firstReceipt || s.receiptNo < r.firstReceipt) r.firstReceipt = s.receiptNo;
      if (!r.lastReceipt || s.receiptNo > r.lastReceipt) r.lastReceipt = s.receiptNo;
    }
    r.beforeDiscount += num(s.total) + num(s.discount);
    r.discounts += num(s.discount);
    r.netSales += num(s.total);
    if (s.paymentMethod in r) r[s.paymentMethod] += num(s.total);
  }
  for (const f of refunds) {
    const r = row(keyOf(f.createdAt));
    r.refunds += num(f.amount);
    r.netSales -= num(f.amount);
  }
  for (const p of payments) row(keyOf(p.createdAt)).collections += num(p.amount);
  for (const e of expenses.filter((x) => !x.voided)) row(by === 'month' ? String(e.date).slice(0, 7) : e.date).expenses += num(e.amount);
  for (const p of supplierPayments) row(keyOf(p.paidAt || p.createdAt)).supplierPaid += num(p.amount);

  const list = Object.values(rows)
    .filter((r) => r.period)
    .sort((a, b) => a.period.localeCompare(b.period))
    .map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' && k !== 'receipts' ? round2(v) : v])));
  const totals = list.reduce((t, r) => {
    for (const [k, v] of Object.entries(r)) if (typeof v === 'number') t[k] = round2((t[k] || 0) + v);
    return t;
  }, { period: 'Total' });
  return { rows: list, totals };
}

/**
 * Money that actually came in and went out, by payment method.
 * Credit sales are not money yet: they raise receivables until repaid.
 */
export function moneyFlow({ sales = [], refunds = [], payments = [], expenses = [], supplierPayments = [] }) {
  const methods = {};
  const m = (k) => (methods[k] ||= { method: k, label: MONEY_METHODS[k] || k, sales: 0, collections: 0, refunds: 0, expenses: 0, suppliers: 0 });
  for (const s of sales) if (s.paymentMethod !== 'credit') m(s.paymentMethod).sales += num(s.total);
  for (const p of payments) m(p.method).collections += num(p.amount);
  for (const f of refunds) {
    if (num(f.cashAmount)) m('cash').refunds += num(f.cashAmount);
    if (num(f.gcashAmount)) m('gcash').refunds += num(f.gcashAmount);
  }
  for (const e of expenses.filter((x) => !x.voided)) m(e.method || 'cash').expenses += num(e.amount);
  for (const p of supplierPayments) m(p.method || 'cash').suppliers += num(p.amount);

  m('cash');
  m('gcash');
  const rows = Object.values(methods).map((r) => {
    const moneyIn = round2(r.sales + r.collections);
    const moneyOut = round2(r.refunds + r.expenses + r.suppliers);
    return { ...Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? round2(v) : v])), moneyIn, moneyOut, net: round2(moneyIn - moneyOut) };
  }).sort((a, b) => Object.keys(MONEY_METHODS).indexOf(a.method) - Object.keys(MONEY_METHODS).indexOf(b.method));
  const total = (k) => sum(rows, (r) => r[k]);
  return { rows, moneyIn: total('moneyIn'), moneyOut: total('moneyOut'), net: total('net') };
}

/** Credit (accounts receivable) movement in the period, plus who owes what now. */
export function receivables({ sales = [], refunds = [], payments = [], accounts = [] }) {
  const creditSales = sum(sales.filter((s) => s.paymentMethod === 'credit'), (s) => s.total);
  const creditRefunds = sum(refunds, (f) => f.creditAmount);
  const collected = sum(payments, (p) => p.amount);
  const owing = accounts.filter((a) => num(a.balance) > 0).sort((a, b) => num(b.balance) - num(a.balance));
  return {
    creditSales, creditRefunds, collected,
    netChange: round2(creditSales - creditRefunds - collected),
    outstanding: sum(owing, (a) => a.balance),
    students: sum(owing.filter((a) => a.type !== 'staff'), (a) => a.balance),
    staff: sum(owing.filter((a) => a.type === 'staff'), (a) => a.balance),
    accounts: owing.map((a) => ({ name: a.name, idNumber: a.idNumber || '', type: a.type || '', balance: round2(num(a.balance)), limit: num(a.limit) })),
  };
}

/** Supplier bills (deliveries) in the period, payments made, and what is still owed. */
export function payables({ deliveries = [], allDeliveries = [], supplierPayments = [], today = new Date() }) {
  const unpaid = allDeliveries.filter((d) => deliveryBalance(d) > 0);
  const bySupplier = {};
  for (const d of unpaid) {
    const s = (bySupplier[d.supplierId || d.supplierName || '—'] ||= { supplier: d.supplierName || 'No supplier', owed: 0, overdue: 0, deliveries: 0 });
    s.owed = round2(s.owed + deliveryBalance(d));
    s.deliveries += 1;
    if (payableStatus(d, today) === 'overdue') s.overdue = round2(s.overdue + deliveryBalance(d));
  }
  return {
    billed: sum(deliveries, (d) => d.total),
    paid: sum(supplierPayments, (p) => p.amount),
    outstanding: sum(unpaid, deliveryBalance),
    overdue: sum(unpaid.filter((d) => payableStatus(d, today) === 'overdue'), deliveryBalance),
    suppliers: Object.values(bySupplier).sort((a, b) => b.owed - a.owed),
  };
}

/** Closed shifts in the period: what the drawer should have had vs what was counted. */
export function drawerSummary(shifts = []) {
  const closed = shifts.filter((s) => s.status === 'closed');
  const rows = closed
    .sort((a, b) => time(a.closedAt) - time(b.closedAt))
    .map((s) => ({ shiftNo: s.shiftNo || '', staff: s.staffName || '', closedAt: toDate(s.closedAt), expected: round2(num(s.expectedCash)), counted: round2(num(s.countedCash)), difference: round2(num(s.difference)) }));
  return {
    rows,
    expected: sum(rows, (r) => r.expected),
    counted: sum(rows, (r) => r.counted),
    over: sum(rows.filter((r) => r.difference > 0), (r) => r.difference),
    short: sum(rows.filter((r) => r.difference < 0), (r) => -r.difference),
    net: sum(rows, (r) => r.difference),
    open: shifts.filter((s) => s.status === 'open').length,
  };
}

/** Every money event in time order — the journal an accountant can tick off. */
export function journal({ sales = [], refunds = [], payments = [], expenses = [], supplierPayments = [] }) {
  const out = [
    ...sales.map((s) => ({ when: toDate(s.createdAt), ref: s.receiptNo || '', type: 'Sale', party: s.creditAccountName || '', method: s.paymentMethod, debit: 0, credit: num(s.total), note: s.cashierName ? `Cashier: ${s.cashierName}` : '' })),
    ...refunds.map((f) => ({ when: toDate(f.createdAt), ref: f.refundNo || '', type: f.type === 'void' ? 'Void' : 'Refund', party: f.creditAccountName || '', method: f.method, debit: num(f.amount), credit: 0, note: `${f.receiptNo || ''} · ${f.reason || ''}` })),
    ...payments.map((p) => ({ when: toDate(p.createdAt), ref: p.reference || '', type: 'Credit repayment', party: p.accountName || '', method: p.method, debit: 0, credit: num(p.amount), note: p.note || '' })),
    ...expenses.filter((e) => !e.voided).map((e) => ({ when: toDate(e.createdAt) || toDate(`${e.date}T12:00`), ref: '', type: 'Expense', party: e.paidTo || '', method: e.fromDrawer ? 'cash' : e.method, debit: num(e.amount), credit: 0, note: [e.category, e.notes].filter(Boolean).join(' · ') })),
    ...supplierPayments.map((p) => ({ when: toDate(p.paidAt || p.createdAt), ref: p.paymentNo || '', type: 'Supplier payment', party: p.supplierName || '', method: p.method, debit: num(p.amount), credit: 0, note: p.reference || '' })),
  ];
  return out.sort((a, b) => (a.when?.getTime() || 0) - (b.when?.getTime() || 0));
}

/** Everything the Accounting page and its Excel export need, from raw records. */
export function buildAccounting({ sales = [], refunds = [], payments = [], expenses = [], supplierPayments = [], deliveries = [], allDeliveries = [], accounts = [], shifts = [], movements = [], costOf = () => 0, from, to, by = 'day', today = new Date() }) {
  const pl = profitAndLoss({ sales, refunds, movements, expenses, costOf });
  return {
    period: { from: dayKey(from), to: dayKey(to), by },
    pl,
    discounts: sum(sales, (s) => s.discount),
    receipts: sales.length,
    book: salesBook({ sales, refunds, payments, expenses, supplierPayments, from, to, by }),
    money: moneyFlow({ sales, refunds, payments, expenses, supplierPayments }),
    receivables: receivables({ sales, refunds, payments, accounts }),
    payables: payables({ deliveries, allDeliveries, supplierPayments, today }),
    drawer: drawerSummary(shifts),
    journal: journal({ sales, refunds, payments, expenses, supplierPayments }),
  };
}

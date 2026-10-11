import { round2 } from './checkout';
import { toDate } from './format';

/**
 * Credit statement for one account between `from` and `to` (Dates).
 * sales: credit sales on the account · refunds: refunds with creditAmount · payments: repayments
 */
export function buildStatement({ sales = [], refunds = [], payments = [], from, to }) {
  const entries = [
    ...sales.map((s) => ({ when: toDate(s.createdAt), kind: 'Purchase', ref: s.receiptNo, detail: (s.items || []).map((i) => `${i.qty}× ${i.name}`).join(', '), amount: Number(s.total) || 0 })),
    ...refunds.filter((r) => Number(r.creditAmount) > 0).map((r) => ({ when: toDate(r.createdAt), kind: 'Refund', ref: r.refundNo, detail: `${r.receiptNo} · ${r.reason || ''}`, amount: -Number(r.creditAmount) })),
    ...payments.map((p) => ({ when: toDate(p.createdAt), kind: 'Payment', ref: p.method === 'payroll' ? 'Payroll' : p.method === 'gcash' ? 'GCash' : 'Cash', detail: [p.reference, p.note].filter(Boolean).join(' · '), amount: -Number(p.amount) || 0 })),
  ].filter((e) => e.when).sort((a, b) => a.when - b.when);

  const before = entries.filter((e) => e.when < from);
  const period = entries.filter((e) => e.when >= from && e.when <= to);
  const opening = round2(before.reduce((t, e) => t + e.amount, 0));
  let running = opening;
  const lines = period.map((e) => {
    running = round2(running + e.amount);
    return { ...e, balance: running };
  });
  return {
    opening,
    purchases: round2(period.filter((e) => e.kind === 'Purchase').reduce((t, e) => t + e.amount, 0)),
    credits: round2(-period.filter((e) => e.kind !== 'Purchase').reduce((t, e) => t + e.amount, 0)),
    closing: running,
    lines,
  };
}

/** Plain-text version for email. */
export function statementText({ account, statement, from, to, canteenName, fmt }) {
  const d = (x) => x.toLocaleDateString();
  const rows = statement.lines.map((l) => `${d(l.when)}  ${l.kind.padEnd(8)} ${String(l.ref || '').padEnd(10)} ${fmt(l.amount).padStart(12)}  bal ${fmt(l.balance)}`);
  return [
    `${canteenName} — credit statement`,
    `${account.name} (${account.idNumber})`,
    `Period: ${d(from)} to ${d(to)}`,
    '',
    `Opening balance: ${fmt(statement.opening)}`,
    ...rows,
    '',
    `Purchases: ${fmt(statement.purchases)}`,
    `Payments and refunds: ${fmt(statement.credits)}`,
    `Balance due: ${fmt(statement.closing)}`,
  ].join('\n');
}

import { round2 } from './checkout';

/* ---------------- stock counts ---------------- */

/** items: [{ expected, counted (null = not counted), cost }] */
export function countVariances(items) {
  const lines = items
    .filter((i) => i.counted !== null && i.counted !== undefined && i.counted !== '')
    .map((i) => {
      const delta = round2(Number(i.counted) - Number(i.expected));
      return { ...i, counted: Number(i.counted), delta, value: round2(delta * (Number(i.cost) || 0)) };
    });
  return {
    lines,
    counted: lines.length,
    notCounted: items.length - lines.length,
    changed: lines.filter((l) => l.delta !== 0).length,
    shortValue: round2(lines.filter((l) => l.value < 0).reduce((t, l) => t + l.value, 0)),
    overValue: round2(lines.filter((l) => l.value > 0).reduce((t, l) => t + l.value, 0)),
    netValue: round2(lines.reduce((t, l) => t + l.value, 0)),
  };
}

/* ---------------- expiry ---------------- */

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const parseDay = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

/** Whole days until an expiry date ('YYYY-MM-DD'); negative when already expired. */
export const daysLeft = (expiryDate, today = new Date()) => Math.round((parseDay(expiryDate) - dayStart(today)) / 86_400_000);

/** Open batches expiring within `days`, soonest first. */
export function expiringSoon(batches, days = 7, today = new Date()) {
  return batches
    .filter((b) => b.status !== 'closed' && b.expiryDate && daysLeft(b.expiryDate, today) <= days)
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
}

/* ---------------- supplier payables ---------------- */

export const deliveryBalance = (d) => round2(Math.max(Number(d.total) - (Number(d.paidAmount) || 0), 0));

export function addDays(date, days) {
  const d = dayStart(date instanceof Date ? date : new Date(date));
  d.setDate(d.getDate() + (Number(days) || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'paid' | 'overdue' | 'due-soon' (≤ 3 days) | 'open' */
export function payableStatus(d, today = new Date()) {
  if (deliveryBalance(d) <= 0) return 'paid';
  if (!d.dueDate) return 'open';
  const left = daysLeft(d.dueDate, today);
  return left < 0 ? 'overdue' : left <= 3 ? 'due-soon' : 'open';
}

/** Pays the oldest unpaid deliveries first. Returns { allocations, leftover }. */
export function allocateOldestFirst(amount, deliveries) {
  let left = round2(Number(amount));
  const allocations = [];
  const open = deliveries
    .filter((d) => deliveryBalance(d) > 0)
    .sort((a, b) => String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) || String(a.deliveryNo).localeCompare(String(b.deliveryNo)));
  for (const d of open) {
    if (left <= 0) break;
    const pay = round2(Math.min(left, deliveryBalance(d)));
    allocations.push({ deliveryId: d.id, deliveryNo: d.deliveryNo, amount: pay });
    left = round2(left - pay);
  }
  return { allocations, leftover: left };
}

/* ---------------- expenses ---------------- */
export const EXPENSE_CATEGORIES = ['Gas / LPG', 'Electricity', 'Water', 'Wages', 'Rent', 'Supplies', 'Repairs', 'Transport', 'Other'];

import { round2 } from './checkout';

/** Quantity of each sale line that can still be refunded. */
export const refundableQty = (sale) => (sale.items || []).map((l, i) => Math.max(Number(l.qty) - (Number(sale.refundedQty?.[i]) || 0), 0));

/**
 * picks = { [lineIndex]: qty }. Returns { lines, gross, amount, full, error }.
 * The sale's discount is shared proportionally, and the last refund on a sale always
 * returns exactly what is left, so refunds never add up to more than was paid.
 */
export function computeRefund(sale, picks) {
  const left = refundableQty(sale);
  const lines = [];
  for (const [k, v] of Object.entries(picks || {})) {
    const i = Number(k);
    const q = Number(v);
    if (!q) continue;
    const item = sale.items?.[i];
    if (!item) return { error: 'Unknown item on this sale.' };
    if (!Number.isInteger(q) || q < 0) return { error: `${item.name}: enter a whole number.` };
    if (q > left[i]) return { error: `${item.name}: only ${left[i]} can still be refunded.` };
    lines.push({ index: i, productId: item.productId, name: item.name, modifiers: item.modifiers || [], qty: q, price: Number(item.price), cost: Number(item.cost) || 0, lineTotal: round2(q * Number(item.price)) });
  }
  if (!lines.length) return { error: 'Choose at least one item to refund.' };
  const gross = round2(lines.reduce((t, l) => t + l.lineTotal, 0));
  const ratio = Number(sale.subtotal) > 0 ? Number(sale.total) / Number(sale.subtotal) : 0;
  const remaining = round2(Number(sale.total) - (Number(sale.refundedTotal) || 0));
  const full = lines.reduce((t, l) => t + l.qty, 0) === left.reduce((t, q) => t + q, 0);
  const amount = full ? remaining : Math.min(round2(gross * ratio), remaining);
  return { lines, gross, amount, full, error: '' };
}

/**
 * How the money goes back. Cash/GCash: all of it to the customer the same way.
 * Credit: lowers the account balance; any part already repaid goes back in cash.
 */
export function refundSplit(method, amount, accountBalance = 0) {
  if (method !== 'credit') return { creditAmount: 0, cashAmount: method === 'cash' ? amount : 0, gcashAmount: method === 'gcash' ? amount : 0 };
  const creditAmount = round2(Math.min(amount, Math.max(Number(accountBalance) || 0, 0)));
  return { creditAmount, cashAmount: round2(amount - creditAmount), gcashAmount: 0 };
}

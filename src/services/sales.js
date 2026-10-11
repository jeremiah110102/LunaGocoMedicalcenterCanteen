import { db, doc, runTransaction, serverTimestamp } from '../db';
import { auth } from '../firebase';
import { computeTotals, findShortages, findUnavailable, linePricing, receiptNumber, round2, validatePayment } from '../lib/checkout';
import { takeNumber } from './common';
import { applyStock, readForLines } from './stock';

export class SaleError extends Error {}

/**
 * Records a sale in one transaction: re-reads prices and stock, rejects duplicates,
 * checks stock and payment, deducts stock (products, recipes, add-ons, meal sets),
 * updates the credit balance and writes the sale.
 *
 * saleId is created once per checkout attempt, so a double-click, a retry, or an
 * offline sale being sent again can never be recorded twice.
 *
 * allowOversell: the cashier confirmed selling items that are out of stock. Stock goes
 * below zero (the next delivery or stock count brings it back) and the sale lists what was oversold.
 *
 * offline: the sale already happened at the counter without internet. It is recorded
 * with the prices the customer paid; problems (stock ran out, over credit limit, price
 * changed) are noted on the sale for review instead of blocking it.
 */
export async function processSale({ saleId, cart, discount, method, tendered, reference, accountId, shiftId = '', profile, offline = null, allowOversell = false }) {
  if (!cart.length) throw new SaleError('Cart is empty.');
  if (method === 'credit' && !accountId) throw new SaleError('Choose a credit account.');

  return runTransaction(db, async (tx) => {
    // ---- reads (all before writes) ----
    const saleRef = doc(db, 'sales', saleId);
    const accountRef = method === 'credit' ? doc(db, 'creditAccounts', accountId) : null;
    const [existing, accountSnap, counter, stock] = await Promise.all([
      tx.get(saleRef),
      accountRef ? tx.get(accountRef) : null,
      takeNumber(tx, 'sales'),
      readForLines(tx, cart),
    ]);
    if (existing.exists()) return { duplicate: true, sale: { id: existing.id, ...existing.data() } };
    const { productsById, ingredientsById, needs } = stock;
    const review = [];

    const unavailable = findUnavailable(cart, productsById);
    if (unavailable.length) {
      if (!offline) throw new SaleError(unavailable.join('\n'));
      review.push(...unavailable);
    }

    // Prices come from the database (offline sales keep what the customer actually paid).
    const lines = cart.map((l) => {
      const p = productsById[l.productId];
      const priced = p ? linePricing(p, l.modifiers || []) : { error: `${l.name}: product no longer exists` };
      if (priced.error && !offline) throw new SaleError(priced.error);
      const dbPrice = priced.error ? null : priced.unitPrice;
      const price = offline ? round2(Number(l.price)) : dbPrice;
      if (offline && dbPrice !== null && dbPrice !== price) review.push(`${l.name}: sold at ${price}, price now ${dbPrice}`);
      return {
        productId: l.productId,
        name: p?.name || l.name,
        sku: p?.sku || '',
        price,
        basePrice: p ? round2(Number(p.price)) : price,
        modifiers: priced.modifiers || (l.modifiers || []).map((name) => ({ name, price: 0 })),
        cost: Number(p?.cost) || 0,
        qty: Number(l.qty),
        lineTotal: round2(price * Number(l.qty)),
      };
    });

    let account = null;
    if (accountRef) {
      if (!accountSnap.exists()) throw new SaleError('Credit account not found.');
      account = { id: accountSnap.id, ...accountSnap.data() };
    }

    // ---- validation ----
    const shortages = findShortages(needs, productsById, ingredientsById);
    if (shortages.length && !offline && !allowOversell) throw new SaleError(`Not enough stock:\n${shortages.join('\n')}`);
    const totals = computeTotals(lines, discount);
    const pay = validatePayment({ method, total: totals.total, tendered, reference, account });
    if (!pay.ok) {
      if (!offline || !account) throw new SaleError(pay.error);
      review.push(pay.error);
    }

    // ---- writes ----
    counter.write();
    const receiptNo = receiptNumber(counter.next);
    applyStock(tx, stock, { sign: -1, reason: 'sale', note: receiptNo, extra: { saleId }, profile });
    if (offline) review.push(...shortages.map((x) => `Stock ran out — ${x}`));

    if (account) {
      tx.update(accountRef, { balance: round2(Number(account.balance || 0) + totals.total), updatedAt: serverTimestamp() });
    }

    const sale = {
      receiptNo,
      items: lines,
      subtotal: totals.subtotal,
      discount: totals.discount,
      discountType: discount?.type || 'none',
      discountValue: Number(discount?.value) || 0,
      total: totals.total,
      paymentMethod: method,
      tendered: method === 'cash' ? round2(Number(tendered)) : totals.total,
      change: pay.ok ? pay.change : 0,
      reference: method === 'gcash' ? String(reference).trim() : '',
      creditAccountId: account?.id || '',
      creditAccountName: account?.name || '',
      cashierId: profile.id,
      cashierName: profile.displayName || profile.email || '',
      accountUid: auth.currentUser?.uid || '',
      shiftId: shiftId || '',
      status: 'completed',
      refundedTotal: 0,
      ...(shortages.length ? { oversold: shortages } : {}),
      ...(offline ? { offline: true, offlineAt: offline.at, offlineNo: offline.tempNo, needsReview: review.length > 0, reviewNotes: review } : {}),
      createdAt: serverTimestamp(),
    };
    tx.set(saleRef, sale);
    return { duplicate: false, sale: { id: saleId, ...sale, createdAt: offline ? new Date(offline.at) : new Date() } };
  });
}

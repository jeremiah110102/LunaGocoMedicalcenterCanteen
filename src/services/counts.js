import { db, addDoc, collection, doc, runTransaction, serverTimestamp, updateDoc } from '../db';
import { round2 } from '../lib/checkout';
import { countVariances } from '../lib/inventoryMath';
import { logAudit } from '../lib/audit';
import { numbered, takeNumber } from './common';
import { changeStock } from './inventory';

const COL = { product: 'products', ingredient: 'ingredients' };

/** Starts a count: snapshots what the system thinks is on hand for each item. */
export async function startCount({ items, scopeLabel, profile }) {
  if (!items.length) throw new Error('Nothing to count in this selection.');
  const ref = doc(collection(db, 'stockCounts'));
  const count = await runTransaction(db, async (tx) => {
    const counter = await takeNumber(tx, 'stockCounts');
    counter.write();
    const data = {
      countNo: numbered('SC', counter.next),
      status: 'open',
      scope: scopeLabel,
      items: items.map((i) => ({ itemType: i.itemType, itemId: i.id, name: i.name, unit: i.unit || '', expected: Number(i.stock) || 0, counted: null, cost: Number(i.cost) || 0 })),
      createdById: profile.id,
      createdByName: profile.displayName || '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    tx.set(ref, data);
    return { id: ref.id, ...data };
  });
  await logAudit(profile, 'count.start', { countNo: count.countNo, items: items.length });
  return count;
}

export const saveCount = (count, items) => updateDoc(doc(db, 'stockCounts', count.id), { items, updatedAt: serverTimestamp() });

export async function cancelCount(count, profile) {
  await updateDoc(doc(db, 'stockCounts', count.id), { status: 'cancelled', updatedAt: serverTimestamp() });
  await logAudit(profile, 'count.cancel', { countNo: count.countNo });
}

/**
 * Posts a count: each counted item is adjusted by (counted − expected). The difference is
 * applied to the stock as it is now, so sales made while counting are not lost.
 */
export async function postCount({ count, items, profile }) {
  const v = countVariances(items);
  if (!v.counted) throw new Error('Enter at least one counted quantity.');
  const ref = doc(db, 'stockCounts', count.id);
  await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists() || s.data().status !== 'open') throw new Error('This count was already posted or cancelled.');
    const changed = v.lines.filter((l) => l.delta !== 0);
    const refs = changed.map((l) => doc(db, COL[l.itemType], l.itemId));
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));
    changed.forEach((l, i) => {
      if (!snaps[i].exists()) return;
      const item = snaps[i].data();
      const have = Number(item.stock) || 0;
      const after = round2(Math.max(have + l.delta, 0));
      tx.update(refs[i], { stock: after, updatedAt: serverTimestamp() });
      tx.set(doc(collection(db, 'stockMovements')), {
        itemType: l.itemType, itemId: l.itemId, itemName: item.name,
        change: round2(after - have), stockAfter: after, reason: 'count',
        note: `${count.countNo}: counted ${l.counted}, system ${l.expected}`,
        countId: count.id, byId: profile.id, byName: profile.displayName || '', createdAt: serverTimestamp(),
      });
    });
    tx.update(ref, {
      status: 'posted', items,
      result: { counted: v.counted, changed: v.changed, shortValue: v.shortValue, overValue: v.overValue, netValue: v.netValue },
      postedById: profile.id, postedByName: profile.displayName || '', postedAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
  });
  await logAudit(profile, 'count.post', { countNo: count.countNo, changed: v.changed, netValue: v.netValue });
  return v;
}

/* ---------------- expiry batches ---------------- */

/** Closes a batch; any quantity thrown away is recorded as expired waste. */
export async function closeBatch({ batch, discardQty, profile }) {
  const q = round2(Number(discardQty) || 0);
  if (q < 0) throw new Error('Enter zero or more.');
  if (q > 0) await changeStock({ itemType: batch.itemType, itemId: batch.itemId, change: -q, reason: 'expired', note: `${batch.deliveryNo} batch, expiry ${batch.expiryDate}`, profile });
  await updateDoc(doc(db, 'batches', batch.id), { status: 'closed', discarded: q, closedByName: profile.displayName || '', closedAt: serverTimestamp(), updatedAt: serverTimestamp() });
  await logAudit(profile, 'batch.close', { item: batch.name, expiryDate: batch.expiryDate, discarded: q });
}

/* ---------------- expenses ---------------- */

export async function addExpense({ date, category, amount, method, paidTo, notes, shift, fromDrawer, profile }, addCashOut) {
  const amt = round2(Number(amount));
  if (!(amt > 0)) throw new Error('Enter an amount greater than zero.');
  if (!date) throw new Error('Choose the date.');
  if (fromDrawer && !shift) throw new Error('Open a shift first to pay from the cash drawer.');
  const ref = await addDoc(collection(db, 'expenses'), {
    date, category, amount: amt, method: fromDrawer ? 'cash' : method,
    paidTo: String(paidTo || '').trim(), notes: String(notes || '').trim(),
    fromDrawer: !!fromDrawer, shiftId: fromDrawer ? shift.id : '',
    voided: false, byId: profile.id, byName: profile.displayName || '',
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  if (fromDrawer) await addCashOut({ shiftId: shift.id, type: 'out', amount: amt, reason: `Expense: ${category}${paidTo ? ` — ${paidTo}` : ''}`, profile });
  await logAudit(profile, 'expense.add', { id: ref.id, category, amount: amt, fromDrawer: !!fromDrawer });
  return ref;
}

export async function voidExpense(expense, reason, profile) {
  if (!String(reason || '').trim()) throw new Error('Give a reason.');
  await updateDoc(doc(db, 'expenses', expense.id), { voided: true, voidReason: String(reason).trim(), voidedByName: profile.displayName || '', updatedAt: serverTimestamp() });
  await logAudit(profile, 'expense.void', { id: expense.id, amount: expense.amount, reason });
}

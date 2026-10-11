import { db, collection, doc, getDocs, query, runTransaction, serverTimestamp, where } from '../db';
import { auth } from '../firebase';
import { round2 } from '../lib/checkout';
import { cashDifference, countTotal, summarizeShift } from '../lib/shifts';
import { logAudit } from '../lib/audit';
import { numbered, takeNumber } from './common';

/** The open shift of a staff member, or null. */
export async function findOpenShift(staffId) {
  const snap = await getDocs(query(collection(db, 'shifts'), where('staffId', '==', staffId)));
  const open = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.status === 'open');
  return open[0] || null;
}

export async function openShift({ openingCash, profile }) {
  const cash = round2(Number(openingCash));
  if (!(cash >= 0) || openingCash === '') throw new Error('Enter the cash in the drawer at the start of the shift (0 if empty).');
  if (await findOpenShift(profile.id)) throw new Error('You already have an open shift.');
  const ref = doc(collection(db, 'shifts'));
  const shift = await runTransaction(db, async (tx) => {
    const counter = await takeNumber(tx, 'shifts');
    counter.write();
    const data = {
      shiftNo: numbered('SH', counter.next),
      staffId: profile.id,
      staffName: profile.displayName || '',
      status: 'open',
      openingCash: cash,
      cashEvents: [],
      accountUid: auth.currentUser?.uid || '',
      openedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    };
    tx.set(ref, data);
    return { id: ref.id, ...data, openedAt: new Date() };
  });
  await logAudit(profile, 'shift.open', { shiftNo: shift.shiftNo, openingCash: cash });
  return shift;
}

/** Cash put into (type 'in') or taken out of ('out') the drawer during a shift. */
export async function addCashEvent({ shiftId, type, amount, reason, profile }) {
  const amt = round2(Number(amount));
  if (!(amt > 0)) throw new Error('Enter an amount greater than zero.');
  if (!String(reason || '').trim()) throw new Error('Say what the cash was for.');
  const ref = doc(db, 'shifts', shiftId);
  await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists() || s.data().status !== 'open') throw new Error('This shift is not open.');
    const ev = { type, amount: amt, reason: String(reason).trim(), byName: profile.displayName || '', at: new Date().toISOString() };
    tx.update(ref, { cashEvents: [...(s.data().cashEvents || []), ev], updatedAt: serverTimestamp() });
  });
  await logAudit(profile, `shift.cash${type === 'in' ? 'In' : 'Out'}`, { shiftId, amount: amt, reason });
}

/** Everything that happened in a shift (for the live summary and the closing report). */
export async function shiftActivity(shift) {
  const byShift = (col) => getDocs(query(collection(db, col), where('shiftId', '==', shift.id))).then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() })));
  const [sales, refunds, payments] = await Promise.all([byShift('sales'), byShift('refunds'), byShift('creditPayments')]);
  return { sales, refunds, payments, summary: summarizeShift({ openingCash: shift.openingCash, sales, refunds, payments, cashEvents: shift.cashEvents || [] }) };
}

export async function closeShift({ shift, counts, notes = '', profile }) {
  const activity = await shiftActivity(shift);
  const countedCash = countTotal(counts);
  const ref = doc(db, 'shifts', shift.id);
  const result = await runTransaction(db, async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists() || s.data().status !== 'open') throw new Error('This shift is already closed.');
    // Use the latest pay-ins/outs (someone may have added one while counting)
    const summary = summarizeShift({ openingCash: shift.openingCash, sales: activity.sales, refunds: activity.refunds, payments: activity.payments, cashEvents: s.data().cashEvents || [] });
    const difference = cashDifference(countedCash, summary.expectedCash);
    tx.update(ref, {
      status: 'closed',
      counts: Object.fromEntries(Object.entries(counts).filter(([, v]) => Number(v) > 0).map(([k, v]) => [String(k), Number(v)])),
      countedCash,
      expectedCash: summary.expectedCash,
      difference,
      summary,
      notes: String(notes).trim(),
      closedById: profile.id,
      closedByName: profile.displayName || '',
      closedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { countedCash, expectedCash: summary.expectedCash, difference };
  });
  await logAudit(profile, 'shift.close', { shiftNo: shift.shiftNo, expected: result.expectedCash, counted: countedCash, difference: result.difference });
  return result;
}

import { db, doc } from '../db';

export const COUNTERS = ['sales', 'purchaseOrders', 'deliveries', 'refunds', 'shifts', 'stockCounts', 'supplierPayments'];
export const numbered = (prefix, n) => `${prefix}-${String(n).padStart(6, '0')}`;

/**
 * Reserves the next number from counters/{id} inside a transaction.
 * Call it during the read phase; call .write() during the write phase.
 */
export async function takeNumber(tx, id) {
  const ref = doc(db, 'counters', id);
  const snap = await tx.get(ref);
  const next = snap.exists() ? Number(snap.data().next) + 1 : 1;
  return {
    next,
    write: () => (snap.exists() ? tx.update(ref, { next }) : tx.set(ref, { next })),
  };
}

export const actor = (profile) => ({ byId: profile.id, byName: profile.displayName || '' });

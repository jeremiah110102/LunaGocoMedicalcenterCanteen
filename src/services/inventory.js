import { db, collection, doc, runTransaction, serverTimestamp } from '../db';
import { round2 } from '../lib/checkout';
import { logAudit } from '../lib/audit';

export const MOVEMENT_REASONS = {
  receive: 'Stock received',
  adjust: 'Adjustment',
  spoiled: 'Spoiled',
  expired: 'Expired',
  wasted: 'Wasted',
  sale: 'Sale',
  initial: 'Opening stock',
  count: 'Stock count',
  refund: 'Refund (returned)',
};

export const WASTE_REASONS = ['spoiled', 'expired', 'wasted'];

const COLLECTION_FOR = { product: 'products', ingredient: 'ingredients' };

/**
 * Changes stock on one product or ingredient and records the movement atomically.
 * change > 0 adds stock, change < 0 removes it. Stock can never go below zero.
 */
export async function changeStock({ itemType, itemId, change, reason, note = '', profile }) {
  const delta = round2(Number(change));
  if (!Number.isFinite(delta) || delta === 0) throw new Error('Enter a quantity other than zero.');
  if (reason === 'receive' && delta < 0) throw new Error('Received quantity must be positive.');
  if (WASTE_REASONS.includes(reason) && delta > 0) throw new Error('Waste must reduce stock.');

  const ref = doc(db, COLLECTION_FOR[itemType], itemId);
  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Item not found.');
    const item = snap.data();
    const after = round2((Number(item.stock) || 0) + delta);
    if (after < 0) throw new Error(`Only ${item.stock} ${item.unit || ''} in stock; cannot remove ${-delta}.`);
    tx.update(ref, { stock: after, updatedAt: serverTimestamp() });
    tx.set(doc(collection(db, 'stockMovements')), {
      itemType,
      itemId,
      itemName: item.name,
      change: delta,
      stockAfter: after,
      reason,
      note: String(note).trim(),
      byId: profile.id,
      byName: profile.displayName || profile.email || '',
      createdAt: serverTimestamp(),
    });
    return { name: item.name, after };
  });
  await logAudit(profile, `stock.${reason}`, { itemType, itemId, itemName: result.name, change: delta, stockAfter: result.after, note });
  return result;
}

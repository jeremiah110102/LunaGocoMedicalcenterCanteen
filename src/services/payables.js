import { db, collection, doc, runTransaction, serverTimestamp } from '../db';
import { round2 } from '../lib/checkout';
import { allocateOldestFirst, deliveryBalance } from '../lib/inventoryMath';
import { logAudit } from '../lib/audit';
import { numbered, takeNumber } from './common';

export const PAYMENT_METHODS_SUPPLIER = { cash: 'Cash', gcash: 'GCash', bank: 'Bank transfer', check: 'Check' };

/**
 * Pays a supplier. The amount is applied to their unpaid deliveries, oldest due first
 * (or only to `deliveryIds` when given). Updates each delivery's paid amount and status.
 */
export async function recordSupplierPayment({ supplier, deliveries, amount, method, reference = '', deliveryIds = null, profile }) {
  const amt = round2(Number(amount));
  if (!(amt > 0)) throw new Error('Enter an amount greater than zero.');
  if (method !== 'cash' && !String(reference).trim()) throw new Error('Enter the reference / check number.');
  const candidates = deliveries.filter((d) => d.supplierId === supplier.id && (!deliveryIds || deliveryIds.includes(d.id)));
  const ref = doc(collection(db, 'supplierPayments'));

  const payment = await runTransaction(db, async (tx) => {
    const refs = candidates.map((d) => doc(db, 'deliveries', d.id));
    const [counter, ...snaps] = await Promise.all([takeNumber(tx, 'supplierPayments'), ...refs.map((r) => tx.get(r))]);
    const fresh = snaps.filter((s) => s.exists()).map((s) => ({ id: s.id, ...s.data() }));
    const owed = round2(fresh.reduce((t, d) => t + deliveryBalance(d), 0));
    if (amt > owed + 0.001) throw new Error(`That is more than the ${owed.toFixed(2)} owed on the selected deliveries.`);
    const { allocations } = allocateOldestFirst(amt, fresh);

    counter.write();
    for (const a of allocations) {
      const d = fresh.find((x) => x.id === a.deliveryId);
      const paidAmount = round2((Number(d.paidAmount) || 0) + a.amount);
      tx.update(doc(db, 'deliveries', d.id), { paidAmount, paymentStatus: paidAmount >= Number(d.total) - 0.001 ? 'paid' : 'partial', updatedAt: serverTimestamp() });
    }
    const data = {
      paymentNo: numbered('SP', counter.next),
      supplierId: supplier.id,
      supplierName: supplier.name,
      amount: amt,
      method,
      reference: String(reference).trim(),
      allocations,
      byId: profile.id,
      byName: profile.displayName || '',
      paidAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    };
    tx.set(ref, data);
    return { id: ref.id, ...data };
  });
  await logAudit(profile, 'supplier.payment', { paymentNo: payment.paymentNo, supplier: supplier.name, amount: amt, method });
  return payment;
}

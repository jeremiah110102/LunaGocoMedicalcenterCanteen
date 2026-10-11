import { db, collection, doc, runTransaction, serverTimestamp } from '../db';
import { auth } from '../firebase';
import { computeRefund, refundSplit } from '../lib/refunds';
import { round2 } from '../lib/checkout';
import { logAudit } from '../lib/audit';
import { numbered, takeNumber } from './common';
import { applyStock, readForLines } from './stock';

/**
 * Refunds (or voids) items on a sale in one transaction.
 *  approver: the manager/admin staff who approved with their PIN.
 *  restock: put the items back into stock (unopened drinks, untouched food);
 *           otherwise nothing goes back to stock.
 *  shiftId: the current shift, so cash paid out is counted in the drawer.
 */
export async function processRefund({ saleId, picks, reason, restock, approver, shiftId = '', profile }) {
  if (!String(reason || '').trim()) throw new Error('Give a reason for the refund.');
  if (!approver || !['admin', 'manager'].includes(approver.role)) throw new Error('A manager or admin must approve refunds.');
  const saleRef = doc(db, 'sales', saleId);
  const refundRef = doc(collection(db, 'refunds'));

  const result = await runTransaction(db, async (tx) => {
    const saleSnap = await tx.get(saleRef);
    if (!saleSnap.exists()) throw new Error('Sale not found.');
    const sale = { id: saleId, ...saleSnap.data() };
    const r = computeRefund(sale, picks);
    if (r.error) throw new Error(r.error);

    const accountRef = sale.paymentMethod === 'credit' && sale.creditAccountId ? doc(db, 'creditAccounts', sale.creditAccountId) : null;
    const stockLines = r.lines.map((l) => ({ productId: l.productId, qty: l.qty, modifiers: (l.modifiers || []).map((m) => m.name) }));
    const [counter, accountSnap, stock] = await Promise.all([
      takeNumber(tx, 'refunds'),
      accountRef ? tx.get(accountRef) : null,
      restock ? readForLines(tx, stockLines) : null,
    ]);
    const account = accountSnap?.exists() ? accountSnap.data() : null;
    const split = refundSplit(sale.paymentMethod, r.amount, account?.balance);

    // ---- writes ----
    counter.write();
    const refundNo = numbered('RF', counter.next);
    if (stock) applyStock(tx, stock, { sign: +1, reason: 'refund', note: `${refundNo} · ${sale.receiptNo}`, extra: { saleId, refundId: refundRef.id }, profile });
    if (account && split.creditAmount > 0) {
      tx.update(accountRef, { balance: round2(Number(account.balance) - split.creditAmount), updatedAt: serverTimestamp() });
    }

    const refundedQty = { ...(sale.refundedQty || {}) };
    r.lines.forEach((l) => (refundedQty[l.index] = (Number(refundedQty[l.index]) || 0) + l.qty));
    const refundedTotal = round2((Number(sale.refundedTotal) || 0) + r.amount);
    tx.update(saleRef, { refundedQty, refundedTotal, refundStatus: r.full ? 'full' : 'partial', updatedAt: serverTimestamp() });

    const refund = {
      refundNo,
      type: r.full && !sale.refundedTotal ? 'void' : 'refund',
      saleId,
      receiptNo: sale.receiptNo,
      saleShiftId: sale.shiftId || '',
      lines: r.lines,
      amount: r.amount,
      method: sale.paymentMethod,
      ...split,
      creditAccountId: sale.creditAccountId || '',
      creditAccountName: sale.creditAccountName || '',
      restocked: !!restock,
      reason: String(reason).trim(),
      approvedById: approver.id,
      approvedByName: approver.name,
      byId: profile.id,
      byName: profile.displayName || '',
      shiftId,
      accountUid: auth.currentUser?.uid || '',
      createdAt: serverTimestamp(),
    };
    tx.set(refundRef, refund);
    return { id: refundRef.id, ...refund, createdAt: new Date() };
  });
  await logAudit(profile, `sale.${result.type}`, {
    refundNo: result.refundNo, receiptNo: result.receiptNo, amount: result.amount, approvedBy: result.approvedByName, reason: result.reason, restocked: result.restocked,
  });
  return result;
}

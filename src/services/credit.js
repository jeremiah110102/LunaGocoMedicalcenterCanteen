import { db, collection, doc, runTransaction, serverTimestamp } from '../db';
import { round2 } from '../lib/checkout';
import { logAudit } from '../lib/audit';

/** Records a repayment and lowers the account balance in one transaction. */
export async function recordRepayment({ accountId, amount, method, reference = '', shiftId = '', note = '', profile }) {
  const amt = round2(Number(amount));
  if (!(amt > 0)) throw new Error('Enter an amount greater than zero.');
  if (method === 'gcash' && !String(reference).trim()) throw new Error('Enter the GCash reference number.');

  const ref = doc(db, 'creditAccounts', accountId);
  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error('Account not found.');
    const acct = snap.data();
    const balance = Number(acct.balance) || 0;
    if (amt > balance) throw new Error(`Payment is more than the outstanding balance (${balance.toFixed(2)}).`);
    const after = round2(balance - amt);
    tx.update(ref, { balance: after, updatedAt: serverTimestamp() });
    tx.set(doc(collection(db, 'creditPayments')), {
      accountId,
      accountName: acct.name,
      amount: amt,
      method,
      reference: String(reference).trim(),
      note: String(note).trim(),
      shiftId: method === 'cash' ? shiftId : '',
      balanceAfter: after,
      byId: profile.id,
      byName: profile.displayName || profile.email || '',
      createdAt: serverTimestamp(),
    });
    return { name: acct.name, after };
  });
  await logAudit(profile, 'credit.repayment', { accountId, accountName: result.name, amount: amt, method, balanceAfter: result.after });
  return result;
}

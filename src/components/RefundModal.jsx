import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Field, Modal, useToast } from './ui';
import ManagerApproval from './ManagerApproval';
import { computeRefund, refundSplit, refundableQty } from '../lib/refunds';
import { peso, qty } from '../lib/format';
import { processRefund } from '../services/refunds';
import { useShift } from '../hooks/useShift';

/** Refund some items, or void the whole sale, with manager approval. */
export default function RefundModal({ sale, onClose, onDone }) {
  const { profile } = useAuth();
  const toast = useToast();
  const { shift } = useShift();
  const left = refundableQty(sale);
  const [picks, setPicks] = useState({});
  const [reason, setReason] = useState('');
  const [restock, setRestock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const preview = computeRefund(sale, picks);
  const split = preview.error ? null : refundSplit(sale.paymentMethod, preview.amount, Infinity);
  const all = () => setPicks(Object.fromEntries(left.map((q, i) => [i, q]).filter(([, q]) => q > 0)));

  const approve = async (approver) => {
    setErr('');
    if (preview.error) return setErr(preview.error);
    if (!reason.trim()) return setErr('Give a reason for the refund.');
    setBusy(true);
    try {
      const r = await processRefund({ saleId: sale.id, picks, reason, restock, approver, shiftId: shift?.id || '', profile });
      const back = [r.cashAmount > 0 && `${peso(r.cashAmount)} cash`, r.gcashAmount > 0 && `${peso(r.gcashAmount)} by GCash`, r.creditAmount > 0 && `${peso(r.creditAmount)} off the credit balance`].filter(Boolean).join(' + ');
      toast(`${r.refundNo}: refund ${back || peso(r.amount)}.`);
      onDone?.(r);
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal wide title={`Refund / void — ${sale.receiptNo}`} onClose={onClose}>
      {err && <div className="alert alert-error">{err}</div>}
      <div className="row-between">
        <span className="muted small">Choose what to refund. The sale's discount is shared across items.</span>
        <button className="btn btn-sm" onClick={all}>Select everything (void)</button>
      </div>
      <table className="mt">
        <thead><tr><th>Item</th><th className="num">Sold</th><th className="num">Can refund</th><th className="num">Refund</th></tr></thead>
        <tbody>
          {sale.items.map((it, i) => (
            <tr key={i}>
              <td>{it.name}{(it.modifiers || []).length > 0 && <div className="muted small">+ {it.modifiers.map((m) => m.name).join(', ')}</div>}</td>
              <td className="num">{qty(it.qty)} × {peso(it.price)}</td>
              <td className="num">{left[i]}</td>
              <td className="num">
                <input className="num" inputMode="numeric" disabled={!left[i]} value={picks[i] ?? ''} placeholder="0"
                  onChange={(e) => setPicks({ ...picks, [i]: e.target.value.replace(/\D/g, '') })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="sum-row sum-total mt"><span>Refund amount</span><span>{preview.error ? '—' : peso(preview.amount)}</span></div>
      {split && sale.paymentMethod === 'credit' && <p className="muted small">Taken off {sale.creditAccountName}’s credit balance; anything they already repaid is given back in cash.</p>}
      {split && sale.paymentMethod === 'gcash' && <p className="muted small">Send the money back by GCash and note the reference in the reason.</p>}
      <div className="grid-2 mt">
        <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Wrong order, spilled drink…" /></Field>
        <label className="check"><input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Put the items back into stock</label>
      </div>
      {!restock && <p className="muted small">Leave unticked for food that was served or thrown away — stock stays as it is.</p>}
      <ManagerApproval label={busy ? 'Refunding…' : 'Approve refund'} onApproved={approve} />
    </Modal>
  );
}

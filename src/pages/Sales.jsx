import { useState } from 'react';
import { db, collection, orderBy, query, where } from '../db';
import { useCollection } from '../hooks/useCollection';
import { ErrorNote, Empty, PageHead, Badge } from '../components/ui';
import { ReceiptModal } from '../components/Receipt';
import RefundModal from '../components/RefundModal';
import { PAYMENT_METHODS } from '../lib/checkout';
import { dayKey, endOfDay, fmtDateTime, peso, startOfDay } from '../lib/format';
import { useAuth } from '../context/AuthContext';
import { can } from '../lib/roles';

export default function Sales() {
  const today = dayKey(new Date());
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [search, setSearch] = useState('');
  const [method, setMethod] = useState('all');
  const [openId, setOpenId] = useState(null);
  const [refunding, setRefunding] = useState(null);
  const [review, setReview] = useState(false);
  const { profile } = useAuth();
  const canRefund = can(profile, 'pos'); // the accountant only views

  const sales = useCollection(
    () =>
      query(
        collection(db, 'sales'),
        where('createdAt', '>=', startOfDay(new Date(`${from}T00:00`))),
        where('createdAt', '<=', endOfDay(new Date(`${to}T00:00`))),
        orderBy('createdAt', 'desc'),
      ),
    [from, to],
  );

  const s = search.trim().toLowerCase();
  const open = sales.docs.find((x) => x.id === openId);
  const rows = sales.docs.filter(
    (x) =>
      (!review || x.needsReview || x.refundedTotal > 0) &&
      (method === 'all' || x.paymentMethod === method) &&
      (!s || x.receiptNo?.toLowerCase().includes(s) || x.cashierName?.toLowerCase().includes(s) || x.creditAccountName?.toLowerCase().includes(s) || x.reference?.toLowerCase().includes(s)),
  );
  const total = rows.reduce((t, x) => t + (Number(x.total) || 0) - (Number(x.refundedTotal) || 0), 0);

  return (
    <>
      <PageHead title="Sales history" sub={`${rows.length} transactions · ${peso(total)} net of refunds`} />
      <div className="filters">
        <label className="field-inline">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field-inline">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="all">All payments</option>
          {Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className="search" placeholder="Receipt no., cashier, account, reference" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="check"><input type="checkbox" checked={review} onChange={(e) => setReview(e.target.checked)} /> Refunded or needs review only</label>
      </div>
      <ErrorNote error={sales.error} />
      <div className="card table-wrap">
        <table>
          <thead>
            <tr><th>Receipt</th><th>Date</th><th>Cashier</th><th>Items</th><th>Payment</th><th className="num">Total</th></tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.id} className="clickable" onClick={() => setOpenId(x.id)}>
                <td className="mono">
                  {x.receiptNo}
                  {x.refundStatus === 'full' && <> <Badge kind="bad">Voided</Badge></>}
                  {x.refundStatus === 'partial' && <> <Badge kind="warn">Part refunded</Badge></>}
                  {x.needsReview && <> <Badge kind="warn">Review</Badge></>}
                  {x.offline && !x.needsReview && <> <Badge>Offline</Badge></>}
                </td>
                <td>{fmtDateTime(x.createdAt)}</td>
                <td>{x.cashierName}</td>
                <td>{x.items?.reduce((n, i) => n + i.qty, 0)}</td>
                <td>
                  <Badge kind={x.paymentMethod === 'credit' ? 'warn' : x.paymentMethod === 'gcash' ? 'info' : 'neutral'}>{PAYMENT_METHODS[x.paymentMethod]}</Badge>
                  {x.creditAccountName && <span className="muted"> {x.creditAccountName}</span>}
                </td>
                <td className="num">{peso(x.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!sales.loading && !rows.length && <Empty>No sales in this period.</Empty>}
      </div>
      {open && !refunding && (
        <ReceiptModal
          sale={open}
          onClose={() => setOpenId(null)}
          actions={canRefund && open.refundStatus !== 'full' && <button className="btn btn-ghost" onClick={() => setRefunding(open)}>Refund / void</button>}
        />
      )}
      {refunding && <RefundModal sale={refunding} onClose={() => { setRefunding(null); setOpenId(null); }} />}
    </>
  );
}

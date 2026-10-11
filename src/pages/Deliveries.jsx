import { useState } from 'react';
import { db, collection, orderBy, query, where } from '../db';
import { useAuth } from '../context/AuthContext';
import { useCollection } from '../hooks/useCollection';
import { Badge, Empty, ErrorNote, Field, Modal, Stat, useToast } from '../components/ui';
import { APP } from '../config/app';
import { round2 } from '../lib/checkout';
import { dayKey, endOfDay, fmtDate, fmtDateTime, peso, qty, startOfDay, toDate } from '../lib/format';
import { receiveDelivery } from '../services/purchasing';
import { deliveryBalance, payableStatus } from '../lib/inventoryMath';
import { PAYMENT_METHODS_SUPPLIER, recordSupplierPayment } from '../services/payables';

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dayKey(d);
};

/** Item lines with quantity and unit cost (used by purchase orders and deliveries). */
export function LinesEditor({ lines, setLines, items, qtyLabel = 'Qty', showExpiry = false }) {
  const total = round2(lines.reduce((t, l) => t + (Number(l.qty) || 0) * (Number(l.unitCost) || 0), 0));
  const setLine = (i, patch) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pick = (i, key) => {
    const it = items.find((x) => `${x.itemType}:${x.itemId}` === key);
    if (it) setLine(i, { ...it, unitCost: String(it.cost) });
  };
  return (
    <div className="box mt">
      <div className="row-between">
        <strong>Items</strong>
        <button type="button" className="btn btn-sm" onClick={() => setLines([...lines, { itemId: '', qty: '', unitCost: '' }])}>Add item</button>
      </div>
      {!items.length && <p className="muted small">Nothing to stock yet. Turn on “Track stock” for products, or add ingredients.</p>}
      {lines.map((l, i) => (
        <div className={`po-row ${showExpiry ? 'po-row-exp' : ''}`} key={i}>
          <select value={l.itemId ? `${l.itemType}:${l.itemId}` : ''} onChange={(e) => pick(i, e.target.value)}>
            <option value="">Choose item…</option>
            {items.map((x) => (
              <option key={`${x.itemType}:${x.itemId}`} value={`${x.itemType}:${x.itemId}`}>
                {x.name} ({x.itemType}, {qty(x.stock)} {x.unit} in stock)
              </option>
            ))}
          </select>
          <input inputMode="decimal" placeholder={`${qtyLabel}${l.unit ? ` (${l.unit})` : ''}`} value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} />
          <input inputMode="decimal" placeholder="Unit cost ₱" value={l.unitCost} onChange={(e) => setLine(i, { unitCost: e.target.value })} />
          {showExpiry && <input type="date" title="Expiry date (optional)" value={l.expiryDate || ''} onChange={(e) => setLine(i, { expiryDate: e.target.value })} />}
          <span className="num small">{peso((Number(l.qty) || 0) * (Number(l.unitCost) || 0))}</span>
          <button type="button" className="icon-btn" onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label="Remove">×</button>
        </div>
      ))}
      <div className="sum-row sum-total"><span>Total</span><span>{peso(total)}</span></div>
    </div>
  );
}

/** "Received deliveries" tab: every delivery that came in, with or without a purchase order. */
export function Deliveries({ suppliers, items, onOpenPO }) {
  const [from, setFrom] = useState(daysAgo(29));
  const [to, setTo] = useState(dayKey(new Date()));
  const [supplierId, setSupplierId] = useState('all');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);
  const [recording, setRecording] = useState(false);

  const list = useCollection(
    () => query(
      collection(db, 'deliveries'),
      where('receivedAt', '>=', startOfDay(new Date(`${from}T00:00`))),
      where('receivedAt', '<=', endOfDay(new Date(`${to}T00:00`))),
      orderBy('receivedAt', 'desc'),
    ),
    [from, to],
  );

  const s = q.trim().toLowerCase();
  const rows = list.docs
    .filter((d) => supplierId === 'all' || d.supplierId === supplierId)
    .filter((d) => !s || [d.deliveryNo, d.poNo, d.referenceNo, d.supplierName, d.receivedByName, ...(d.items || []).map((i) => i.name)]
      .some((x) => String(x || '').toLowerCase().includes(s)));
  const total = rows.reduce((t, d) => t + (Number(d.total) || 0), 0);
  const open = list.docs.find((d) => d.id === openId);

  return (
    <>
      <div className="stats">
        <Stat label="Deliveries in period" value={rows.length} />
        <Stat label="Value received" value={peso(total)} />
        <Stat label="Without a purchase order" value={rows.filter((d) => !d.poId).length} />
      </div>

      <div className="filters">
        <label className="field-inline">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field-inline">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="all">All suppliers</option>
          {suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <input className="search" placeholder="DR, PO, supplier ref, item…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn btn-primary" onClick={() => setRecording(true)} disabled={!suppliers.length}>Record delivery without PO</button>
      </div>

      <ErrorNote error={list.error} />
      <div className="card table-wrap">
        <table>
          <thead><tr><th>DR</th><th>Received</th><th>Supplier</th><th>PO</th><th>Supplier ref</th><th>Items</th><th className="num">Value</th><th>Payment</th><th>Received by</th></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => setOpenId(d.id)}>
                <td className="mono">{d.deliveryNo}</td>
                <td>{fmtDateTime(d.receivedAt)}</td>
                <td>{d.supplierName}</td>
                <td>{d.poNo ? <span className="mono">{d.poNo}</span> : <Badge>No PO</Badge>}</td>
                <td>{d.referenceNo || '—'}</td>
                <td className="small">{(d.items || []).map((i) => `${i.name} × ${qty(i.qty)}`).join(', ')}</td>
                <td className="num">{peso(d.total)}</td>
                <td><PayBadge d={d} /></td>
                <td>{d.receivedByName}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.loading && !rows.length && <Empty>No deliveries received in this period.</Empty>}
      </div>

      {open && <DeliveryDetail delivery={open} onClose={() => setOpenId(null)} onOpenPO={open.poId ? () => { setOpenId(null); onOpenPO(open.poId); } : null} />}
      {recording && <DirectDelivery suppliers={suppliers} items={items} onClose={() => setRecording(false)} />}
    </>
  );
}

function DeliveryDetail({ delivery: d, onClose, onOpenPO }) {
  return (
    <Modal wide title={`${d.deliveryNo} · ${d.supplierName}`} onClose={onClose}
      footer={
        <>
          {onOpenPO && <button className="btn" onClick={onOpenPO}>Open {d.poNo}</button>}
          <button className="btn btn-primary" onClick={() => window.print()}>Print receiving slip</button>
        </>
      }>
      <div className="printable delivery-slip">
        <div className="print-only">
          <strong>{APP.canteenName}</strong> — Receiving slip
        </div>
        <div className="grid-2 slip-meta">
          <div><span className="muted small">Delivery</span><div className="mono">{d.deliveryNo}</div></div>
          <div><span className="muted small">Received</span><div>{fmtDateTime(d.receivedAt)} by {d.receivedByName}</div></div>
          <div><span className="muted small">Supplier</span><div>{d.supplierName}</div></div>
          <div><span className="muted small">Purchase order</span><div>{d.poNo || 'None (direct delivery)'}</div></div>
          <div><span className="muted small">Supplier DR / invoice</span><div>{d.referenceNo || '—'}</div></div>
          <div><span className="muted small">Item costs</span><div>{d.costUpdated ? 'Updated to these prices' : 'Not changed'}</div></div>
          <div><span className="muted small">Payment</span><div><PayBadge d={d} /> {deliveryBalance(d) > 0 ? `${peso(deliveryBalance(d))} owed${d.dueDate ? `, due ${fmtDate(d.dueDate)}` : ''}` : ''}</div></div>
        </div>
        <table className="mt">
          <thead><tr><th>Item</th><th className="num">Quantity</th><th className="num">Unit cost</th><th className="num">Total</th></tr></thead>
          <tbody>
            {d.items.map((l, i) => (
              <tr key={i}>
                <td>{l.name} <span className="muted small">({l.itemType})</span></td>
                <td className="num">{qty(l.qty)} {l.unit}</td>
                <td className="num">{peso(l.unitCost)}</td>
                <td className="num">{peso(l.lineTotal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="sum-row sum-total mt"><span>Total received</span><span>{peso(d.total)}</span></div>
        {d.notes && <p className="mt small"><strong>Notes:</strong> {d.notes}</p>}
        <div className="print-only signatures">
          <span>Received by: ____________________</span>
          <span>Delivered by: ____________________</span>
        </div>
      </div>
    </Modal>
  );
}

function DirectDelivery({ suppliers, items, onClose }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id || '');
  const [lines, setLines] = useState([{ itemId: '', qty: '', unitCost: '' }]);
  const [referenceNo, setReferenceNo] = useState('');
  const [notes, setNotes] = useState('');
  const [updateCost, setUpdateCost] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setErr('');
    setBusy(true);
    try {
      const r = await receiveDelivery({ supplier: suppliers.find((x) => x.id === supplierId), lines, referenceNo, notes, updateCost, profile });
      toast(`${r.deliveryNo} recorded. Stock updated.`);
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal wide title="Record a delivery without a purchase order" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Receive into stock'}</button></>}>
      {err && <div className="alert alert-error">{err}</div>}
      <p className="muted small">For walk-in or unplanned deliveries. The stock is added right away and the delivery gets its own DR number.</p>
      <div className="grid-2">
        <Field label="Supplier">
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            {suppliers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </Field>
        <Field label="Supplier DR / invoice no."><input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} /></Field>
      </div>
      <LinesEditor lines={lines} setLines={setLines} items={items} qtyLabel="Qty received" showExpiry />
      <p className="muted small">Expiry date is optional — add it for perishables so you get a warning before they expire.</p>
      <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <label className="check mt"><input type="checkbox" checked={updateCost} onChange={(e) => setUpdateCost(e.target.checked)} /> Update each item’s cost to these prices</label>
    </Modal>
  );
}

const PAY_LABEL = { paid: ['ok', 'Paid'], overdue: ['bad', 'Overdue'], 'due-soon': ['warn', 'Due soon'], open: ['neutral', 'Unpaid'] };
export function PayBadge({ d }) {
  if (d.paidAmount === undefined && d.paymentStatus === undefined) return <span className="muted small">—</span>;
  const st = payableStatus(d);
  const [kind, label] = PAY_LABEL[st];
  return <Badge kind={kind}>{st === 'open' && Number(d.paidAmount) > 0 ? 'Part paid' : label}</Badge>;
}

/** "Payables" tab: what the canteen owes each supplier, and paying it. */
export function Payables({ suppliers }) {
  const { profile } = useAuth();
  const toast = useToast();
  const deliveries = useCollection(() => collection(db, 'deliveries'), []);
  const payments = useCollection(() => query(collection(db, 'supplierPayments'), orderBy('paidAt', 'desc')), []);
  const [paying, setPaying] = useState(null);

  const unpaid = deliveries.docs.filter((d) => d.paidAmount !== undefined && deliveryBalance(d) > 0);
  const bySupplier = suppliers.map((s) => {
    const mine = unpaid.filter((d) => d.supplierId === s.id);
    return {
      supplier: s,
      deliveries: mine.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))),
      owed: mine.reduce((t, d) => t + deliveryBalance(d), 0),
      overdue: mine.filter((d) => payableStatus(d) === 'overdue').reduce((t, d) => t + deliveryBalance(d), 0),
    };
  }).filter((x) => x.owed > 0).sort((a, b) => b.overdue - a.overdue || b.owed - a.owed);
  const totalOwed = bySupplier.reduce((t, x) => t + x.owed, 0);
  const totalOverdue = bySupplier.reduce((t, x) => t + x.overdue, 0);

  return (
    <>
      <div className="stats">
        <Stat label="Owed to suppliers" value={peso(totalOwed)} kind="accent" />
        <Stat label="Overdue" value={peso(totalOverdue)} kind={totalOverdue > 0 ? 'warn' : undefined} />
        <Stat label="Unpaid deliveries" value={unpaid.length} />
      </div>
      {bySupplier.map(({ supplier, deliveries: list, owed, overdue }) => (
        <section className="card" key={supplier.id}>
          <div className="row-between">
            <h2>{supplier.name} <span className="muted small">· terms {Number(supplier.termsDays) ? `${supplier.termsDays} days` : 'cash on delivery'}</span></h2>
            <div className="row-inline">
              <strong>{peso(owed)}</strong>
              {overdue > 0 && <Badge kind="bad">{peso(overdue)} overdue</Badge>}
              <button className="btn btn-primary btn-sm" onClick={() => setPaying({ supplier, deliveries: list })}>Record payment</button>
            </div>
          </div>
          <table>
            <thead><tr><th>Delivery</th><th>Received</th><th>Due</th><th className="num">Total</th><th className="num">Paid</th><th className="num">Balance</th><th /></tr></thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id}>
                  <td className="mono">{d.deliveryNo}{d.referenceNo ? <span className="muted small"> · {d.referenceNo}</span> : null}</td>
                  <td>{fmtDate(d.receivedAt)}</td>
                  <td>{d.dueDate ? fmtDate(d.dueDate) : '—'}</td>
                  <td className="num">{peso(d.total)}</td>
                  <td className="num">{peso(d.paidAmount)}</td>
                  <td className="num">{peso(deliveryBalance(d))}</td>
                  <td><PayBadge d={d} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {!deliveries.loading && !bySupplier.length && <div className="card"><Empty>Nothing owed. All deliveries are paid.</Empty></div>}

      <h2 className="mt">Payment history</h2>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Payment</th><th>Date</th><th>Supplier</th><th>Method</th><th>Applied to</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {payments.docs.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.paymentNo}</td>
                <td>{fmtDateTime(p.paidAt)} · {p.byName}</td>
                <td>{p.supplierName}</td>
                <td>{PAYMENT_METHODS_SUPPLIER[p.method]}{p.reference ? ` · ${p.reference}` : ''}</td>
                <td className="small">{(p.allocations || []).map((a) => `${a.deliveryNo} ${peso(a.amount)}`).join(', ')}</td>
                <td className="num">{peso(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!payments.loading && !payments.docs.length && <Empty>No supplier payments yet.</Empty>}
      </div>

      {paying && (
        <PaySupplier {...paying} onClose={() => setPaying(null)}
          onPay={async (args) => {
            try {
              const p = await recordSupplierPayment({ supplier: paying.supplier, deliveries: paying.deliveries, profile, ...args });
              toast(`${p.paymentNo}: paid ${peso(p.amount)} to ${p.supplierName}.`);
              setPaying(null);
            } catch (e) {
              toast(e.message, 'error');
            }
          }} />
      )}
    </>
  );
}

function PaySupplier({ supplier, deliveries, onClose, onPay }) {
  const owed = deliveries.reduce((t, d) => t + deliveryBalance(d), 0);
  const [amount, setAmount] = useState(String(round2(owed)));
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [picked, setPicked] = useState([]);
  return (
    <Modal title={`Pay ${supplier.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => onPay({ amount, method, reference, deliveryIds: picked.length ? picked : null })}>Record payment</button></>}>
      <div className="grid-2">
        <Field label="Amount (₱)" hint={`Owed: ${peso(owed)}`}><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Paid by">
          <select value={method} onChange={(e) => setMethod(e.target.value)}>{Object.entries(PAYMENT_METHODS_SUPPLIER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
        {method !== 'cash' && <Field label="Reference / check no."><input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>}
      </div>
      <p className="muted small mt">Applied to the oldest due deliveries first, unless you pick specific ones:</p>
      <ul className="plain-list">
        {deliveries.map((d) => (
          <li key={d.id}>
            <label className="check">
              <input type="checkbox" checked={picked.includes(d.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, d.id] : picked.filter((x) => x !== d.id))} />
              {d.deliveryNo} · due {d.dueDate ? fmtDate(d.dueDate) : '—'} · {peso(deliveryBalance(d))} owed
            </label>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

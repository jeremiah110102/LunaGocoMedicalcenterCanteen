import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { db, addDoc, collection, doc, orderBy, query, serverTimestamp, updateDoc, where } from '../db';
import { useAuth } from '../context/AuthContext';
import { useCollection } from '../hooks/useCollection';
import { Badge, Empty, ErrorNote, Field, Modal, PageHead, Stat, useToast } from '../components/ui';
import { fmtDate, fmtDateTime, peso, qty, toDate } from '../lib/format';
import { logAudit } from '../lib/audit';
import { OPEN_STATUSES, PO_STATUS, createPurchaseOrder, receiveDelivery, remainingQty, setStatus, updateDraft } from '../services/purchasing';
import { Deliveries, LinesEditor, Payables } from './Deliveries';

export const STATUS_KIND = { draft: 'neutral', ordered: 'info', partial: 'warn', received: 'ok', cancelled: 'bad' };

export default function Purchasing() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('orders');
  const [status, setStatusFilter] = useState('open');
  const [editing, setEditing] = useState(null);
  const [openId, setOpenId] = useState(null);

  const orders = useCollection(() => query(collection(db, 'purchaseOrders'), orderBy('createdAt', 'desc')), []);
  const suppliers = useCollection(() => collection(db, 'suppliers'), []);
  const products = useCollection(() => collection(db, 'products'), []);
  const ingredients = useCollection(() => collection(db, 'ingredients'), []);

  // Items that can be ordered: stock-tracked products and ingredients
  const items = useMemo(() => [
    ...products.docs.filter((p) => p.trackStock && !p.archived).map((p) => ({ itemType: 'product', itemId: p.id, name: p.name, unit: p.unit || 'pc', cost: Number(p.cost) || 0, stock: p.stock, lowStock: p.lowStock })),
    ...ingredients.docs.filter((i) => !i.archived).map((i) => ({ itemType: 'ingredient', itemId: i.id, name: i.name, unit: i.unit || '', cost: Number(i.cost) || 0, stock: i.stock, lowStock: i.lowStock })),
  ].sort((a, b) => a.name.localeCompare(b.name)), [products.docs, ingredients.docs]);

  // Opened from "Order stock" on Products / Ingredients: start a PO with that item.
  useEffect(() => {
    const pid = params.get('product');
    const iid = params.get('ingredient');
    if (!pid && !iid) return;
    const it = items.find((x) => (pid ? x.itemType === 'product' && x.itemId === pid : x.itemType === 'ingredient' && x.itemId === iid));
    if (!it) return;
    setEditing({ lines: [{ ...it, qty: '', unitCost: String(it.cost) }] });
    setParams({}, { replace: true });
  }, [params, items, setParams]);

  const lowItems = items.filter((i) => (Number(i.stock) || 0) <= (Number(i.lowStock) || 0));
  const shown = orders.docs.filter((o) => (status === 'open' ? OPEN_STATUSES.includes(o.status) : status === 'all' || o.status === status));
  const openValue = orders.docs.filter((o) => ['ordered', 'partial'].includes(o.status)).reduce((t, o) => t + Math.max((Number(o.total) || 0) - (Number(o.receivedTotal) || 0), 0), 0);
  const open = orders.docs.find((o) => o.id === openId);

  return (
    <>
      <PageHead title="Purchase orders" sub="Order stock from suppliers and receive it into inventory">
        {tab === 'orders' && <button className="btn btn-primary" onClick={() => setEditing({ lines: [] })} disabled={!suppliers.docs.length}>New purchase order</button>}
      </PageHead>

      <div className="stats">
        <Stat label="Open orders" value={orders.docs.filter((o) => OPEN_STATUSES.includes(o.status)).length} sub={`${orders.docs.filter((o) => o.status === 'partial').length} partly received`} />
        <Stat label="Still to arrive" value={peso(openValue)} />
        <Stat label="Items running low" value={lowItems.length} kind={lowItems.length ? 'warn' : undefined}
          sub={lowItems.length ? <button className="link" onClick={() => setEditing({ lines: lowItems.map((i) => ({ ...i, qty: '', unitCost: String(i.cost) })) })}>Order all low items</button> : undefined} />
      </div>

      <div className="tabs">
        <button className={tab === 'orders' ? 'is-on' : ''} onClick={() => setTab('orders')}>Purchase orders</button>
        <button className={tab === 'deliveries' ? 'is-on' : ''} onClick={() => setTab('deliveries')}>Received deliveries</button>
        <button className={tab === 'payables' ? 'is-on' : ''} onClick={() => setTab('payables')}>Payables</button>
        <button className={tab === 'suppliers' ? 'is-on' : ''} onClick={() => setTab('suppliers')}>Suppliers ({suppliers.docs.length})</button>
      </div>

      <ErrorNote error={orders.error || suppliers.error} />

      {tab === 'orders' ? (
        <>
          {!suppliers.loading && !suppliers.docs.length && <div className="alert alert-warn">Add a supplier first (Suppliers tab), then create purchase orders.</div>}
          <div className="filters">
            <select value={status} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="open">Open (draft, ordered, partly received)</option>
              <option value="all">All</option>
              {Object.entries(PO_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="card table-wrap">
            <table>
              <thead><tr><th>PO</th><th>Supplier</th><th>Created</th><th>Expected</th><th>Items</th><th className="num">Total</th><th className="num">Received</th><th>Status</th></tr></thead>
              <tbody>
                {shown.map((o) => (
                  <tr key={o.id} className="clickable" onClick={() => setOpenId(o.id)}>
                    <td className="mono">{o.poNo}</td>
                    <td>{o.supplierName}</td>
                    <td>{fmtDate(o.createdAt)}</td>
                    <td>{o.expectedDate ? fmtDate(o.expectedDate) : '—'}</td>
                    <td>{o.items?.length}</td>
                    <td className="num">{peso(o.total)}</td>
                    <td className="num">{o.receivedTotal ? peso(o.receivedTotal) : '—'}</td>
                    <td><Badge kind={STATUS_KIND[o.status]}>{PO_STATUS[o.status]}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!orders.loading && !shown.length && <Empty>No purchase orders here.</Empty>}
          </div>
        </>
      ) : tab === 'payables' ? (
        <Payables suppliers={suppliers.docs} />
      ) : tab === 'deliveries' ? (
        <Deliveries suppliers={suppliers.docs.filter((x) => x.active !== false)} items={items} onOpenPO={(id) => { setTab('orders'); setOpenId(id); }} />
      ) : (
        <Suppliers suppliers={suppliers.docs} orders={orders.docs} />
      )}

      {editing && <POForm initial={editing} suppliers={suppliers.docs.filter((s) => s.active !== false)} items={items} onClose={() => setEditing(null)} />}
      {open && <PODetail po={open} onClose={() => setOpenId(null)} onEdit={() => { setEditing({ po: open, lines: open.items.map((l) => ({ ...l, qty: String(l.qty), unitCost: String(l.unitCost) })) }); setOpenId(null); }} />}
    </>
  );
}

function POForm({ initial, suppliers, items, onClose }) {
  const { profile } = useAuth();
  const toast = useToast();
  const po = initial.po;
  const [supplierId, setSupplierId] = useState(po?.supplierId || suppliers[0]?.id || '');
  const [lines, setLines] = useState(initial.lines);
  const [notes, setNotes] = useState(po?.notes || '');
  const [expectedDate, setExpectedDate] = useState(po?.expectedDate || '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (asStatus) => {
    setErr('');
    const supplier = suppliers.find((s) => s.id === supplierId);
    setBusy(true);
    try {
      if (po) {
        await updateDraft(po, { supplier, lines, notes, expectedDate }, profile);
        toast('Purchase order updated.');
      } else {
        const created = await createPurchaseOrder({ supplier, lines, notes, expectedDate, status: asStatus, profile });
        toast(`${created.poNo} ${asStatus === 'ordered' ? 'saved and marked ordered' : 'saved as draft'}.`);
      }
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal wide title={po ? `Edit ${po.poNo}` : 'New purchase order'} onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          {po ? (
            <button className="btn btn-primary" disabled={busy} onClick={() => save('draft')}>Save changes</button>
          ) : (
            <>
              <button className="btn" disabled={busy} onClick={() => save('draft')}>Save draft</button>
              <button className="btn btn-primary" disabled={busy} onClick={() => save('ordered')}>Save &amp; mark ordered</button>
            </>
          )}
        </>
      }>
      {err && <div className="alert alert-error">{err}</div>}
      <div className="grid-2">
        <Field label="Supplier">
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Expected delivery"><input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} /></Field>
      </div>

      <LinesEditor lines={lines} setLines={setLines} items={items} />
      <Field label="Notes (delivery instructions, terms…)"><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </Modal>
  );
}

function PODetail({ po, onClose, onEdit }) {
  const { profile } = useAuth();
  const toast = useToast();
  const deliveries = useCollection(() => query(collection(db, 'deliveries'), where('poId', '==', po.id)), [po.id]);
  const [receiving, setReceiving] = useState(false);
  const [quantities, setQuantities] = useState(() => Object.fromEntries(po.items.map((l, i) => [i, String(remainingQty(l))])));
  const [expiries, setExpiries] = useState({});
  const [referenceNo, setReferenceNo] = useState('');
  const [notes, setNotes] = useState('');
  const [updateCost, setUpdateCost] = useState(true);
  const [closeOrder, setCloseOrder] = useState(false);
  const [busy, setBusy] = useState(false);

  const act = async (fn, msg) => {
    setBusy(true);
    try {
      const r = await fn();
      toast(typeof msg === 'function' ? msg(r) : msg);
      onClose();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const open = OPEN_STATUSES.includes(po.status);
  const short = receiving && po.items.some((l, i) => (Number(quantities[i]) || 0) < remainingQty(l));
  const showReceived = po.status !== 'draft' || receiving;
  const history = [...deliveries.docs].sort((a, b) => (toDate(b.receivedAt)?.getTime() || 0) - (toDate(a.receivedAt)?.getTime() || 0));

  return (
    <Modal wide title={`${po.poNo} · ${po.supplierName}`} onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => window.print()}>Print</button>
          {po.status === 'draft' && <button className="btn" onClick={onEdit}>Edit</button>}
          {['draft', 'ordered'].includes(po.status) && <button className="btn btn-ghost" disabled={busy} onClick={() => window.confirm(`Cancel ${po.poNo}?`) && act(() => setStatus(po, 'cancelled', profile), 'Order cancelled.')}>Cancel order</button>}
          {po.status === 'partial' && !receiving && <button className="btn btn-ghost" disabled={busy} onClick={() => window.confirm(`Close ${po.poNo}? No more deliveries will be expected for it.`) && act(() => setStatus(po, 'received', profile), 'Order closed.')}>Close order</button>}
          {po.status === 'draft' && <button className="btn" disabled={busy} onClick={() => act(() => setStatus(po, 'ordered', profile), 'Marked as ordered.')}>Mark ordered</button>}
          {open && !receiving && <button className="btn btn-primary" onClick={() => setReceiving(true)}>Receive delivery</button>}
          {receiving && <button className="btn" onClick={() => setReceiving(false)}>Back</button>}
          {receiving && (
            <button className="btn btn-primary" disabled={busy}
              onClick={() => act(() => receiveDelivery({ poId: po.id, quantities, expiries, referenceNo, notes, updateCost, closeOrder, profile }),
                (r) => `${r.deliveryNo} recorded. ${r.poStatus === 'partial' ? 'Order is partly received.' : 'Order fully received.'}`)}>
              {busy ? 'Saving…' : 'Confirm delivery'}
            </button>
          )}
        </>
      }>
      <div className="printable">
        <div className="row-inline wrap">
          <Badge kind={STATUS_KIND[po.status]}>{PO_STATUS[po.status]}</Badge>
          <span className="muted small">Created {fmtDateTime(po.createdAt)} by {po.createdByName}</span>
          {po.orderedAt && <span className="muted small">· Ordered {fmtDate(po.orderedAt)}</span>}
          {po.expectedDate && <span className="muted small">· Expected {fmtDate(po.expectedDate)}</span>}
          {po.closedShort && <span className="muted small">· Closed before everything arrived</span>}
        </div>
        {receiving && <div className="alert alert-warn mt">Enter what arrived in this delivery. Stock is added when you confirm, and the delivery gets its own DR number.</div>}
        <table className="mt">
          <thead>
            <tr>
              <th>Item</th><th className="num">Ordered</th><th className="num">Unit cost</th>
              {showReceived && <th className="num">Received so far</th>}
              {receiving ? <><th className="num">Arriving now</th><th>Expiry (optional)</th></> : <th className="num">Line total</th>}
            </tr>
          </thead>
          <tbody>
            {po.items.map((l, i) => (
              <tr key={i}>
                <td>{l.name} <span className="muted small">({l.itemType})</span></td>
                <td className="num">{qty(l.qty)} {l.unit}</td>
                <td className="num">{peso(l.unitCost)}</td>
                {showReceived && <td className={`num ${remainingQty(l) > 0 && po.status !== 'draft' ? 'warn-text' : ''}`}>{qty(l.receivedQty || 0)}</td>}
                {receiving ? (
                  <td className="num">
                    <input className="num" inputMode="decimal" value={quantities[i]} disabled={remainingQty(l) <= 0}
                      onChange={(e) => setQuantities({ ...quantities, [i]: e.target.value })} />
                    <div className="muted small">of {qty(remainingQty(l))} left</div>
                  </td>
                ) : <td className="num">{peso(l.lineTotal)}</td>}
                {receiving && <td><input type="date" value={expiries[i] || ''} onChange={(e) => setExpiries({ ...expiries, [i]: e.target.value })} /></td>}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="sum-row sum-total mt"><span>Order total</span><span>{peso(po.total)}</span></div>
        {po.receivedTotal > 0 && <div className="sum-row"><span>Received so far</span><span>{peso(po.receivedTotal)}</span></div>}
        {po.notes && <p className="mt small"><strong>Notes:</strong> {po.notes}</p>}

        {receiving && (
          <div className="grid-2 mt">
            <Field label="Supplier DR / invoice no." hint="From the supplier's delivery receipt"><input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} /></Field>
            <Field label="Notes (damaged items, missing boxes…)"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <label className="check span-2"><input type="checkbox" checked={updateCost} onChange={(e) => setUpdateCost(e.target.checked)} /> Update each item’s cost to the price on this order</label>
            {short && <label className="check span-2"><input type="checkbox" checked={closeOrder} onChange={(e) => setCloseOrder(e.target.checked)} /> Close the order after this delivery (the rest won’t come)</label>}
          </div>
        )}

        {!receiving && history.length > 0 && (
          <>
            <h3 className="mt">Deliveries for this order</h3>
            <ul className="plain-list">
              {history.map((d) => (
                <li key={d.id} className="row-between">
                  <span><span className="mono">{d.deliveryNo}</span> <span className="muted small">{fmtDateTime(d.receivedAt)} · {d.receivedByName}{d.referenceNo ? ` · ref ${d.referenceNo}` : ''}</span></span>
                  <strong>{peso(d.total)}</strong>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}

function Suppliers({ suppliers, orders }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState(null);

  const save = async (s) => {
    const name = s.name.trim();
    if (!name) return toast('Supplier name is required.', 'error');
    if (suppliers.some((x) => x.id !== s.id && x.name.toLowerCase() === name.toLowerCase())) return toast('A supplier with that name exists.', 'error');
    const termsDays = Math.max(0, Math.floor(Number(s.termsDays) || 0));
    const data = { name, contact: s.contact?.trim() || '', phone: s.phone?.trim() || '', email: s.email?.trim() || '', notes: s.notes?.trim() || '', termsDays, active: s.active !== false, updatedAt: serverTimestamp() };
    try {
      if (s.id) {
        await updateDoc(doc(db, 'suppliers', s.id), data);
        await logAudit(profile, 'supplier.update', { id: s.id, name });
      } else {
        const ref = await addDoc(collection(db, 'suppliers'), { ...data, createdAt: serverTimestamp() });
        await logAudit(profile, 'supplier.create', { id: ref.id, name });
      }
      toast('Supplier saved.');
      setEditing(null);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <div className="row-inline"><button className="btn btn-primary" onClick={() => setEditing({ name: '', active: true })}>Add supplier</button></div>
      <div className="card table-wrap mt">
        <table>
          <thead><tr><th>Supplier</th><th>Contact</th><th>Phone</th><th>Terms</th><th>Orders</th><th>Status</th><th /></tr></thead>
          <tbody>
            {[...suppliers].sort((a, b) => a.name.localeCompare(b.name)).map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong>{s.email && <div className="muted small">{s.email}</div>}</td>
                <td>{s.contact || '—'}</td>
                <td>{s.phone || '—'}</td>
                <td>{Number(s.termsDays) ? `${s.termsDays} days` : 'COD'}</td>
                <td>{orders.filter((o) => o.supplierId === s.id).length}</td>
                <td>{s.active === false ? <Badge>Inactive</Badge> : <Badge kind="ok">Active</Badge>}</td>
                <td className="row-actions"><button className="btn btn-sm" onClick={() => setEditing(s)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!suppliers.length && <Empty>No suppliers yet.</Empty>}
      </div>
      {editing && (
        <Modal title={editing.id ? `Edit ${editing.name}` : 'Add supplier'} onClose={() => setEditing(null)}
          footer={<><button className="btn" onClick={() => setEditing(null)}>Cancel</button><button className="btn btn-primary" onClick={() => save(editing)}>Save</button></>}>
          <div className="grid-2">
            <Field label="Name"><input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <Field label="Contact person"><input value={editing.contact || ''} onChange={(e) => setEditing({ ...editing, contact: e.target.value })} /></Field>
            <Field label="Phone"><input value={editing.phone || ''} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} /></Field>
            <Field label="Email"><input type="email" value={editing.email || ''} onChange={(e) => setEditing({ ...editing, email: e.target.value })} /></Field>
            <Field label="Payment terms (days)" hint="0 = cash on delivery; 30 = pay within 30 days"><input inputMode="numeric" value={editing.termsDays ?? ''} onChange={(e) => setEditing({ ...editing, termsDays: e.target.value })} /></Field>
            <Field label="Notes"><input value={editing.notes || ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></Field>
            <label className="check"><input type="checkbox" checked={editing.active !== false} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Active</label>
          </div>
        </Modal>
      )}
    </>
  );
}

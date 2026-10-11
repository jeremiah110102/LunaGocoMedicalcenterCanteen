import { useState } from 'react';
import { db, collection, limit, orderBy, query } from '../db';
import { useAuth } from '../context/AuthContext';
import { useCollection } from '../hooks/useCollection';
import { Badge, Empty, ErrorNote, Field, Modal, PageHead, Stat, useToast } from '../components/ui';
import { fmtDateTime, peso, qty } from '../lib/format';
import { daysLeft } from '../lib/inventoryMath';
import { changeStock, MOVEMENT_REASONS, WASTE_REASONS } from '../services/inventory';
import { StockCounts, Expiring } from './InventoryExtras';
import InventoryExport from '../components/InventoryExport';

export function stockItems(products, ingredients) {
  return [
    ...products.filter((p) => p.trackStock && !p.archived).map((p) => ({ ...p, itemType: 'product', costEach: Number(p.cost) || 0 })),
    ...ingredients.filter((i) => !i.archived).map((i) => ({ ...i, itemType: 'ingredient', costEach: Number(i.cost) || 0 })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

export const isLow = (i) => (Number(i.stock) || 0) <= (Number(i.lowStock) || 0);

export default function Inventory() {
  const products = useCollection(() => collection(db, 'products'), []);
  const ingredients = useCollection(() => collection(db, 'ingredients'), []);
  const movements = useCollection(() => query(collection(db, 'stockMovements'), orderBy('createdAt', 'desc'), limit(300)), []);
  const batches = useCollection(() => collection(db, 'batches'), []);
  const [tab, setTab] = useState('levels');
  const [action, setAction] = useState(null);
  const [q, setQ] = useState('');

  const items = stockItems(products.docs, ingredients.docs);
  const low = items.filter(isLow);
  const value = items.reduce((s, i) => s + (Number(i.stock) || 0) * i.costEach, 0);
  const expiringCount = batches.docs.filter((b) => b.status !== 'closed' && b.expiryDate && daysLeft(b.expiryDate) <= 7).length;
  const s = q.trim().toLowerCase();
  const shown = (tab === 'low' ? low : items).filter((i) => !s || i.name.toLowerCase().includes(s));

  return (
    <>
      <PageHead title="Inventory" sub="Stock levels for tracked products and ingredients">
        <InventoryExport />
        <button className="btn" onClick={() => setAction('waste')}>Record waste</button>
        <button className="btn" onClick={() => setAction('adjust')}>Adjust stock</button>
        <button className="btn btn-primary" onClick={() => setAction('receive')}>Receive stock</button>
      </PageHead>

      <div className="stats">
        <Stat label="Tracked items" value={items.length} />
        <Stat label="Low or out of stock" value={low.length} kind={low.length ? 'warn' : undefined} sub={`${items.filter((i) => Number(i.stock) <= 0).length} out of stock`} />
        <Stat label="Stock value (at cost)" value={peso(value)} />
        <Stat label="Expiring within 7 days" value={expiringCount} kind={expiringCount ? 'warn' : undefined} />
      </div>

      <div className="tabs">
        {[['levels', 'Stock levels'], ['low', `Low stock (${low.length})`], ['expiring', `Expiring (${expiringCount})`], ['counts', 'Stock counts'], ['moves', 'Movement history']].map(([k, v]) => (
          <button key={k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{v}</button>
        ))}
      </div>

      <ErrorNote error={products.error || ingredients.error || movements.error} />

      {tab === 'counts' ? (
        <StockCounts items={items} />
      ) : tab === 'expiring' ? (
        <Expiring batches={batches.docs} />
      ) : tab !== 'moves' ? (
        <>
          <div className="filters"><input className="search" placeholder="Search items" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <div className="card table-wrap">
            <table>
              <thead><tr><th>Item</th><th>Kind</th><th className="num">In stock</th><th className="num">Alert at</th><th>Status</th></tr></thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={`${i.itemType}-${i.id}`}>
                    <td><strong>{i.name}</strong></td>
                    <td>{i.itemType === 'product' ? 'Product' : 'Ingredient'}</td>
                    <td className={`num ${Number(i.stock) < 0 ? 'neg' : ''}`}>{qty(i.stock)} {i.unit}</td>
                    <td className="num">{qty(i.lowStock)}</td>
                    <td>{Number(i.stock) <= 0 ? <Badge kind="bad">Out of stock</Badge> : isLow(i) ? <Badge kind="warn">Low</Badge> : <Badge kind="ok">OK</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!shown.length && <Empty>{tab === 'low' ? 'Nothing is running low.' : 'No tracked items. Turn on stock tracking for products, or add ingredients.'}</Empty>}
          </div>
        </>
      ) : (
        <MovementTable rows={movements.docs} />
      )}

      {action && <StockAction kind={action} items={items} onClose={() => setAction(null)} />}
    </>
  );
}

export function MovementTable({ rows }) {
  return (
    <div className="card table-wrap">
      <table>
        <thead><tr><th>When</th><th>Item</th><th>Reason</th><th className="num">Change</th><th className="num">After</th><th>Note</th><th>By</th></tr></thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td>{fmtDateTime(m.createdAt)}</td>
              <td>{m.itemName} <span className="muted small">({m.itemType})</span></td>
              <td>{MOVEMENT_REASONS[m.reason] || m.reason}</td>
              <td className={`num ${m.change < 0 ? 'neg' : 'pos'}`}>{m.change > 0 ? '+' : ''}{qty(m.change)}</td>
              <td className="num">{qty(m.stockAfter)}</td>
              <td className="small">{m.note}</td>
              <td className="small">{m.byName}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <Empty>No stock movements yet.</Empty>}
    </div>
  );
}

function StockAction({ kind, items, onClose }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [key, setKey] = useState('');
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState('add');
  const [wasteReason, setWasteReason] = useState('spoiled');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const item = items.find((i) => `${i.itemType}:${i.id}` === key);
  const titles = { receive: 'Receive stock', adjust: 'Adjust stock', waste: 'Record waste' };

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!item) return setErr('Choose an item.');
    const n = Number(amount);
    if (!(n > 0)) return setErr('Enter a quantity greater than zero.');
    if (kind === 'adjust' && !note.trim()) return setErr('Give a reason for the adjustment (e.g. physical count).');
    const change = kind === 'receive' ? n : kind === 'waste' ? -n : direction === 'add' ? n : -n;
    const reason = kind === 'waste' ? wasteReason : kind;
    setBusy(true);
    try {
      const r = await changeStock({ itemType: item.itemType, itemId: item.id, change, reason, note, profile });
      toast(`${r.name}: now ${qty(r.after)} ${item.unit || ''}`);
      onClose();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={titles[kind]} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="sform" disabled={busy}>Save</button></>}>
      <form id="sform" onSubmit={submit} className="stack">
        {err && <div className="alert alert-error">{err}</div>}
        <Field label="Item">
          <select value={key} onChange={(e) => setKey(e.target.value)} required>
            <option value="">Choose…</option>
            {items.map((i) => <option key={`${i.itemType}:${i.id}`} value={`${i.itemType}:${i.id}`}>{i.name} — {qty(i.stock)} {i.unit}</option>)}
          </select>
        </Field>
        {kind === 'adjust' && (
          <div className="seg">
            <button type="button" className={direction === 'add' ? 'is-on' : ''} onClick={() => setDirection('add')}>Add</button>
            <button type="button" className={direction === 'remove' ? 'is-on' : ''} onClick={() => setDirection('remove')}>Remove</button>
          </div>
        )}
        {kind === 'waste' && (
          <Field label="Reason">
            <select value={wasteReason} onChange={(e) => setWasteReason(e.target.value)}>
              {WASTE_REASONS.map((r) => <option key={r} value={r}>{MOVEMENT_REASONS[r]}</option>)}
            </select>
          </Field>
        )}
        <Field label={`Quantity${item ? ` (${item.unit})` : ''}`}><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
        <Field label={kind === 'receive' ? 'Supplier / delivery note' : 'Note'}><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}

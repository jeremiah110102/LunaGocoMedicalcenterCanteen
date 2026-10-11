import { useMemo, useState } from 'react';
import { db, collection, orderBy, query } from '../db';
import { useAuth } from '../context/AuthContext';
import { useCollection } from '../hooks/useCollection';
import { Badge, Empty, Field, Modal, Stat, useToast } from '../components/ui';
import { countVariances, daysLeft } from '../lib/inventoryMath';
import { fmtDate, fmtDateTime, peso, qty } from '../lib/format';
import { cancelCount, closeBatch, postCount, saveCount, startCount } from '../services/counts';

/* ---------------- stock counts ---------------- */

export function StockCounts({ items }) {
  const { profile } = useAuth();
  const toast = useToast();
  const counts = useCollection(() => query(collection(db, 'stockCounts'), orderBy('createdAt', 'desc')), []);
  const [scope, setScope] = useState('all');
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    const pick = scope === 'all' ? items : items.filter((i) => i.itemType === scope);
    setBusy(true);
    try {
      const c = await startCount({ items: pick, scopeLabel: { all: 'Everything', product: 'Products', ingredient: 'Ingredients' }[scope], profile });
      toast(`${c.countNo} started. Count the shelves and enter what you find.`);
      setOpenId(c.id);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const open = counts.docs.find((c) => c.id === openId);
  return (
    <>
      <div className="box row-inline wrap">
        <strong>New stock count</strong>
        <select value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="all">Everything</option>
          <option value="ingredient">Ingredients only</option>
          <option value="product">Products only</option>
        </select>
        <button className="btn btn-primary" disabled={busy} onClick={start}>Start count</button>
        <span className="muted small">Saves what the system expects now; selling can continue while you count.</span>
      </div>
      <div className="card table-wrap mt">
        <table>
          <thead><tr><th>Count</th><th>Scope</th><th>Started</th><th>Status</th><th className="num">Items changed</th><th className="num">Net value</th></tr></thead>
          <tbody>
            {counts.docs.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => setOpenId(c.id)}>
                <td className="mono">{c.countNo}</td>
                <td>{c.scope}</td>
                <td>{fmtDateTime(c.createdAt)} · {c.createdByName}</td>
                <td>{c.status === 'posted' ? <Badge kind="ok">Posted</Badge> : c.status === 'cancelled' ? <Badge>Cancelled</Badge> : <Badge kind="info">In progress</Badge>}</td>
                <td className="num">{c.result?.changed ?? '—'}</td>
                <td className={`num ${c.result?.netValue < 0 ? 'neg' : ''}`}>{c.result ? peso(c.result.netValue) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!counts.loading && !counts.docs.length && <Empty>No stock counts yet.</Empty>}
      </div>
      {open && <CountSheet count={open} onClose={() => setOpenId(null)} />}
    </>
  );
}

function CountSheet({ count, onClose }) {
  const { profile } = useAuth();
  const toast = useToast();
  const editable = count.status === 'open';
  const [items, setItems] = useState(count.items);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const v = useMemo(() => countVariances(items), [items]);
  const setCounted = (i, val) => setItems(items.map((x, j) => (j === i ? { ...x, counted: val === '' ? null : val } : x)));

  const act = async (fn, msg) => {
    setBusy(true);
    try {
      await fn();
      toast(msg);
      onClose();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const s = q.trim().toLowerCase();
  return (
    <Modal wide title={`${count.countNo} · ${count.scope}`} onClose={onClose}
      footer={editable ? (
        <>
          <button className="btn btn-ghost" disabled={busy} onClick={() => window.confirm('Cancel this count? Nothing will change.') && act(() => cancelCount(count, profile), 'Count cancelled.')}>Cancel count</button>
          <button className="btn" disabled={busy} onClick={() => act(() => saveCount(count, items), 'Progress saved.')}>Save progress</button>
          <button className="btn btn-primary" disabled={busy || !v.counted}
            onClick={() => window.confirm(`Post ${v.counted} counted item(s)? ${v.changed} will be adjusted (net ${peso(v.netValue)}).`) && act(() => postCount({ count, items, profile }), 'Count posted. Stock adjusted.')}>
            Post count
          </button>
        </>
      ) : <button className="btn" onClick={() => window.print()}>Print</button>}>
      <div className="stats">
        <Stat label="Counted" value={`${v.counted} / ${items.length}`} />
        <Stat label="Shortage value" value={peso(v.shortValue)} kind={v.shortValue < 0 ? 'warn' : undefined} />
        <Stat label="Overage value" value={peso(v.overValue)} />
        <Stat label="Net" value={peso(v.netValue)} />
      </div>
      <div className="filters"><input className="search" placeholder="Find item" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="printable">
        <table>
          <thead><tr><th>Item</th><th className="num">System</th><th className="num">Counted</th><th className="num">Difference</th><th className="num">Value</th></tr></thead>
          <tbody>
            {items.map((it, i) => {
              if (s && !it.name.toLowerCase().includes(s)) return null;
              const line = v.lines.find((l) => l.itemId === it.itemId && l.itemType === it.itemType);
              return (
                <tr key={`${it.itemType}${it.itemId}`} className={line?.delta ? 'row-warn' : ''}>
                  <td>{it.name} <span className="muted small">({it.itemType})</span></td>
                  <td className="num">{qty(it.expected)} {it.unit}</td>
                  <td className="num">
                    {editable
                      ? <input className="num" inputMode="decimal" value={it.counted ?? ''} placeholder="—" onChange={(e) => setCounted(i, e.target.value)} />
                      : it.counted ?? '—'}
                  </td>
                  <td className={`num ${line?.delta < 0 ? 'neg' : line?.delta > 0 ? 'pos' : ''}`}>{line ? `${line.delta > 0 ? '+' : ''}${qty(line.delta)}` : ''}</td>
                  <td className="num">{line ? peso(line.value) : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {count.status === 'posted' && <p className="muted small mt">Posted {fmtDateTime(count.postedAt)} by {count.postedByName}.</p>}
    </Modal>
  );
}

/* ---------------- expiring batches ---------------- */

export function Expiring({ batches }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [showAll, setShowAll] = useState(false);
  const [closing, setClosing] = useState(null);
  const [discard, setDiscard] = useState('');
  const open = batches.filter((b) => b.status !== 'closed').sort((a, b) => String(a.expiryDate).localeCompare(String(b.expiryDate)));
  const rows = showAll ? open : open.filter((b) => daysLeft(b.expiryDate) <= 14);

  const close = async () => {
    try {
      await closeBatch({ batch: closing, discardQty: discard, profile });
      toast(Number(discard) > 0 ? `Recorded ${discard} ${closing.unit} of ${closing.name} as expired.` : 'Batch marked used up.');
      setClosing(null);
      setDiscard('');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <div className="filters">
        <label className="check"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all open batches (not just the next 14 days)</label>
        <span className="muted small">Batches come from deliveries where an expiry date was entered. Use the oldest first.</span>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Item</th><th>Expires</th><th>Days left</th><th className="num">Received</th><th>Delivery</th><th /></tr></thead>
          <tbody>
            {rows.map((b) => {
              const d = daysLeft(b.expiryDate);
              return (
                <tr key={b.id} className={d < 0 ? 'row-bad' : d <= 3 ? 'row-warn' : ''}>
                  <td><strong>{b.name}</strong></td>
                  <td>{fmtDate(b.expiryDate)}</td>
                  <td>{d < 0 ? <Badge kind="bad">Expired {-d}d ago</Badge> : d === 0 ? <Badge kind="bad">Today</Badge> : <Badge kind={d <= 3 ? 'warn' : 'neutral'}>{d} days</Badge>}</td>
                  <td className="num">{qty(b.qty)} {b.unit}</td>
                  <td className="small">{b.deliveryNo} · {b.supplierName}</td>
                  <td className="row-actions"><button className="btn btn-sm" onClick={() => { setClosing(b); setDiscard(''); }}>Used up / discard</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <Empty>Nothing expiring soon.</Empty>}
      </div>
      {closing && (
        <Modal title={`${closing.name} · expires ${fmtDate(closing.expiryDate)}`} onClose={() => setClosing(null)}
          footer={<><button className="btn" onClick={() => setClosing(null)}>Cancel</button><button className="btn btn-primary" onClick={close}>Close batch</button></>}>
          <p className="muted small">If all of it was used, leave 0. Anything thrown away is taken off stock and recorded as expired waste.</p>
          <Field label={`Quantity thrown away (${closing.unit})`}><input inputMode="decimal" value={discard} placeholder="0" onChange={(e) => setDiscard(e.target.value)} /></Field>
        </Modal>
      )}
    </>
  );
}

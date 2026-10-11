import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { db, collection, doc, query, updateDoc, serverTimestamp, where } from '../db';
import { useAuth } from '../context/AuthContext';
import { useCollection, byId } from '../hooks/useCollection';
import { useShift } from '../hooks/useShift';
import { useToast, ErrorNote, Empty, Modal } from '../components/ui';
import { ReceiptModal } from '../components/Receipt';
import { CameraScanner, cameraScanSupported, useOfflineQueue, useScanner } from '../components/Scanning';
import { OpenShiftForm } from './Shifts';
import { APP } from '../config/app';
import { availableCount, computeTotals, lineKey, linePricing, validatePayment, PAYMENT_METHODS, round2 } from '../lib/checkout';
import { peso } from '../lib/format';
import { SaleError } from '../services/sales';
import { sellOrQueue } from '../services/offline';
import { beepError, beepOk, beepWarn, buzz, unlockAudio, warmScanner } from '../lib/scanner';
import { getDeviceSettings } from '../lib/deviceSettings';

const newSaleId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const norm = (s) => String(s || '').trim().toLowerCase();

export default function POS() {
  const { profile } = useAuth();
  const toast = useToast();
  const { shift, loading: shiftLoading } = useShift();
  const { online, queue } = useOfflineQueue();
  // cacheKey: the cashier screen keeps working from the last copy when offline
  const products = useCollection(() => query(collection(db, 'products'), where('archived', '==', false)), [], { cacheKey: 'pos.products' });
  const ingredients = useCollection(() => collection(db, 'ingredients'), [], { cacheKey: 'pos.ingredients' });
  const categories = useCollection(() => collection(db, 'categories'), [], { cacheKey: 'pos.categories' });
  const accounts = useCollection(() => query(collection(db, 'creditAccounts'), where('active', '==', true)), [], { cacheKey: 'pos.accounts' });

  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('all');
  const [cart, setCart] = useState([]);
  const [discount, setDiscount] = useState({ type: 'none', value: '' });
  const [method, setMethod] = useState('cash');
  const [tendered, setTendered] = useState('');
  const [reference, setReference] = useState('');
  const [accountId, setAccountId] = useState('');
  const [accountSearch, setAccountSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [picking, setPicking] = useState(null); // product whose add-ons are being chosen
  const [camera, setCamera] = useState(null); // 'products' | 'account'
  const [oversell, setOversell] = useState(null); // { p, mods, avail, fromScan } waiting for confirmation
  const saleIdRef = useRef(newSaleId());

  useEffect(() => warmScanner(), []);
  const needShift = APP.requireShift !== false;
  const blocked = needShift && !shiftLoading && !shift;
  const prodById = useMemo(() => byId(products.docs), [products.docs]);
  const ingById = useMemo(() => byId(ingredients.docs), [ingredients.docs]);
  const account = accounts.docs.find((a) => a.id === accountId);

  const visible = useMemo(() => {
    const s = norm(search);
    return products.docs
      .filter((p) => cat === 'all' || p.categoryId === cat)
      .filter((p) => !s || norm(p.name).includes(s) || norm(p.sku).includes(s) || norm(p.barcode) === s)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products.docs, search, cat]);

  const totals = computeTotals(cart, discount);
  const pay = validatePayment({ method, total: totals.total, tendered, reference, account });
  const inCart = (id) => cart.filter((l) => l.productId === id).reduce((t, l) => t + l.qty, 0);

  const sound = (kind) => {
    if (!getDeviceSettings().scanSound) return;
    if (kind === 'ok') beepOk();
    else if (kind === 'warn') beepWarn();
    else beepError();
    buzz(kind === 'ok' ? 30 : 120);
  };

  /** How a product stands after adding one more: 'ok' | 'low' | 'out' (out = selling beyond stock). */
  const stockState = (p) => {
    const avail = availableCount(p, ingById, prodById);
    if (!Number.isFinite(avail)) return { state: 'ok', avail };
    const after = avail - (inCart(p.id) + 1);
    if (after < 0) return { state: 'out', avail };
    if (after <= (Number(p.lowStock) || 0)) return { state: 'low', avail, after };
    return { state: 'ok', avail, after };
  };

  /**
   * Adds one of a product. Out of stock: asks first (unless confirmed), then still sells.
   * Returns { ok, text } for the scanner's feedback list.
   */
  const addLine = (p, modifiers = [], { confirmed = false, fromScan = false } = {}) => {
    if (p.soldOut) {
      if (fromScan) sound('error');
      toast(`${p.name} is marked sold out.`, 'error');
      return { ok: false, text: `${p.name} — marked sold out` };
    }
    const priced = linePricing(p, modifiers);
    if (priced.error) {
      toast(priced.error, 'error');
      return { ok: false, text: priced.error };
    }
    const st = stockState(p);
    const alreadyConfirmed = cart.some((l) => l.productId === p.id && l.oversell);
    if (st.state === 'out' && !confirmed && !alreadyConfirmed) {
      sound('warn');
      setOversell({ p, mods: modifiers, avail: st.avail, fromScan });
      return { ok: false, text: `${p.name} — out of stock, confirm to sell` };
    }
    const key = lineKey(p.id, modifiers);
    const oversold = st.state === 'out';
    setCart((c) => (c.some((l) => l.key === key)
      ? c.map((l) => (l.key === key ? { ...l, qty: l.qty + 1, oversell: l.oversell || oversold } : l))
      : [...c, { key, productId: p.id, name: p.name, price: priced.unitPrice, qty: 1, modifiers, modifierLabels: priced.modifiers, oversell: oversold }]));
    if (oversold) {
      if (fromScan) sound('warn');
      return { ok: true, text: `${p.name} added — OUT OF STOCK` };
    }
    if (st.state === 'low') {
      if (fromScan) sound('warn');
      toast(`${p.name} is running low: ${Math.max(st.after, 0)} left after this (alert at ${Number(p.lowStock) || 0}).`, 'warn');
      return { ok: true, text: `${p.name} added — only ${Math.max(st.after, 0)} left` };
    }
    if (fromScan) sound('ok');
    return { ok: true, text: `${p.name} added · ${peso(priced.unitPrice)}` };
  };

  const tap = (p, opts = {}) => {
    if ((p.modifiers || []).length) {
      if (opts.fromScan) sound('ok');
      setPicking(p);
      return { ok: true, text: `${p.name} — choose add-ons` };
    }
    return addLine(p, [], opts);
  };

  const setQty = (key, q) => {
    const n = Math.max(0, Math.floor(Number(q) || 0));
    setCart((c) => (n === 0 ? c.filter((l) => l.key !== key) : c.map((l) => (l.key === key ? { ...l, qty: n } : l))));
  };

  // Barcode / ID scanner: product barcode or SKU adds the item; a student/staff ID picks the credit account.
  const handleScan = useCallback((code) => {
    const c = norm(code);
    const p = products.docs.find((x) => norm(x.barcode) === c || norm(x.sku) === c);
    if (p) return tap(p, { fromScan: true });
    const a = accounts.docs.find((x) => norm(x.idNumber) === c);
    if (a) {
      sound('ok');
      setMethod('credit');
      setAccountId(a.id);
      setAccountSearch('');
      toast(`Credit account: ${a.name}`);
      return { ok: true, text: `Credit: ${a.name}` };
    }
    sound('error');
    toast(`No product or ID matches “${code}”.`, 'error');
    return { ok: false, text: `Not found: ${code}` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [products.docs, accounts.docs, cart, ingById, prodById]);
  useScanner(handleScan);

  const reset = () => {
    setCart([]);
    setDiscount({ type: 'none', value: '' });
    setTendered('');
    setReference('');
    setAccountId('');
    setAccountSearch('');
    setMethod('cash');
    saleIdRef.current = newSaleId();
  };

  const checkout = async () => {
    if (!pay.ok || busy || blocked) return;
    setBusy(true);
    try {
      const res = await sellOrQueue({
        saleId: saleIdRef.current,
        cart: cart.map(({ key, modifierLabels, oversell: _o, ...l }) => l),
        discount: { type: discount.type, value: Number(discount.value) || 0 },
        method,
        tendered,
        reference,
        accountId,
        accountName: account?.name || '',
        shiftId: shift?.id || '',
        allowOversell: cart.some((l) => l.oversell),
        profile,
      });
      if (res.duplicate) toast('This sale was already recorded.', 'warn');
      if (res.queued) toast('No connection — sale saved on this device and will be sent automatically.', 'warn');
      setReceipt(res.sale);
    } catch (e) {
      toast(e instanceof SaleError ? e.message : `Sale failed: ${e.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleSoldOut = async (p) => {
    try {
      await updateDoc(doc(db, 'products', p.id), { soldOut: !p.soldOut, updatedAt: serverTimestamp() });
      toast(`${p.name} ${p.soldOut ? 'is available again' : 'marked sold out'}.`);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const onSearchKey = (e) => {
    if (e.key !== 'Enter' || !search.trim()) return;
    const c = norm(search);
    const exact = products.docs.find((x) => norm(x.barcode) === c || norm(x.sku) === c) || (visible.length === 1 ? visible[0] : null);
    if (exact) {
      tap(exact);
      setSearch('');
    } else handleScan(search);
  };

  const matchingAccounts = accounts.docs
    .filter((a) => {
      const s = norm(accountSearch);
      return !s || norm(a.name).includes(s) || norm(a.idNumber).includes(s);
    })
    .slice(0, 6);

  const quickCash = [...new Set([totals.total, 50, 100, 200, 500, 1000].filter((v) => v >= totals.total && v > 0))].slice(0, 5);

  return (
    <div className="pos">
      <section className="pos-menu">
        {(!online || queue.length > 0) && (
          <div className={`alert ${online ? 'alert-warn' : 'alert-error'}`}>
            {online ? `${queue.length} offline sale(s) still sending…` : `Offline — sales are saved on this device${queue.length ? ` (${queue.length} waiting)` : ''} and sent when the internet is back.`}
          </div>
        )}
        <div className="pos-tools">
          <div className="row-inline">
            <input className="search" placeholder="Search, type a SKU, or scan a barcode…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={onSearchKey} />
            <button className="btn scan-btn" onClick={() => { unlockAudio(); setCamera('products'); }} title="Scan barcodes or QR codes with the camera">
              <span aria-hidden>▣</span> Scan
            </button>
          </div>
          <div className="chips">
            <button className={`chip ${cat === 'all' ? 'is-on' : ''}`} onClick={() => setCat('all')}>All</button>
            {[...categories.docs].sort((a, b) => a.name.localeCompare(b.name)).map((c) => (
              <button key={c.id} className={`chip ${cat === c.id ? 'is-on' : ''}`} onClick={() => setCat(c.id)}>{c.name}</button>
            ))}
          </div>
        </div>
        <ErrorNote error={products.error} />
        {!products.loading && !visible.length && <Empty>No products found. Add products on the Products page.</Empty>}
        <div className="tiles">
          {visible.map((p) => {
            const avail = availableCount(p, ingById, prodById);
            const out = p.soldOut;
            const empty = !p.soldOut && avail <= 0;
            const low = !out && !empty && Number.isFinite(avail) && avail <= (Number(p.lowStock) || 0);
            return (
              <div key={p.id} className={`tile ${out ? 'is-out' : ''} ${empty ? 'is-empty' : ''}`}>
                <button className="tile-main" onClick={() => { unlockAudio(); tap(p); }} disabled={out}>
                  {empty && <span className="tile-oos">Out of stock</span>}
                  {p.imageUrl && <img className="tile-img" src={p.imageUrl} alt="" loading="lazy" />}
                  <span className="tile-name">{p.name}</span>
                  {p.type === 'combo' && <span className="tile-tag">Meal set</span>}
                  <span className="tile-price">{peso(p.price)}</span>
                  <span className="tile-meta">
                    {p.soldOut ? 'Sold out' : avail <= 0 ? `${avail < 0 ? avail : 0} in stock` : Number.isFinite(avail) ? `${avail} left` : 'Available'}
                    {(p.modifiers || []).length > 0 && ' · add-ons'}
                    {low && <span className="dot-warn" aria-label="low stock" />}
                  </span>
                  {inCart(p.id) > 0 && <span className="tile-count">{inCart(p.id)}</span>}
                </button>
                <button className="tile-flag" onClick={() => toggleSoldOut(p)} title={p.soldOut ? 'Mark available' : 'Mark sold out'}>
                  {p.soldOut ? 'Restock' : 'Sold out'}
                </button>
              </div>
            );
          })}
        </div>
      </section>

      <aside className="pos-cart">
        {blocked ? (
          <>
            <h2>Open your shift</h2>
            <p className="muted small">Count the cash in the drawer and open your shift before selling.</p>
            <OpenShiftForm />
            <Link className="link small" to="/shifts">Shifts &amp; cash drawer →</Link>
          </>
        ) : (
          <>
            <div className="cart-head">
              <h2>Current order</h2>
              {cart.length > 0 && <button className="link" onClick={reset}>Clear</button>}
            </div>
            {shift && <div className="muted small">{shift.shiftNo} · {profile.displayName}</div>}

            <div className="cart-lines">
              {!cart.length && <Empty>Tap a product, or scan its barcode.</Empty>}
              {cart.map((l) => (
                <div className="cart-line" key={l.key}>
                  <div className="cart-line-name">
                    <span>{l.name}</span>
                    {(l.modifierLabels || []).length > 0 && <span className="muted small">+ {l.modifierLabels.map((m) => m.name).join(', ')}</span>}
                    {l.oversell && <span className="oos-note">⚠ Out of stock — selling anyway</span>}
                    <span className="muted">{peso(l.price)}</span>
                  </div>
                  <div className="qty">
                    <button onClick={() => setQty(l.key, l.qty - 1)} aria-label="Less">−</button>
                    <input value={l.qty} inputMode="numeric" onChange={(e) => setQty(l.key, e.target.value)} aria-label="Quantity" />
                    <button onClick={() => prodById[l.productId] && addLine(prodById[l.productId], l.modifiers, { confirmed: l.oversell })} aria-label="More">+</button>
                  </div>
                  <span className="cart-line-total">{peso(round2(l.price * l.qty))}</span>
                </div>
              ))}
            </div>

            <div className="cart-section">
              <div className="row-inline">
                <span className="field-label">Discount</span>
                <select value={discount.type} onChange={(e) => setDiscount({ type: e.target.value, value: '' })}>
                  <option value="none">None</option>
                  <option value="percent">Percent %</option>
                  <option value="amount">Amount ₱</option>
                </select>
                {discount.type !== 'none' && (
                  <input className="num" inputMode="decimal" placeholder="0" value={discount.value} onChange={(e) => setDiscount((d) => ({ ...d, value: e.target.value }))} />
                )}
              </div>
              <div className="sum-row"><span>Subtotal</span><span>{peso(totals.subtotal)}</span></div>
              {totals.discount > 0 && <div className="sum-row"><span>Discount</span><span>−{peso(totals.discount)}</span></div>}
              <div className="sum-row sum-total"><span>Total</span><span>{peso(totals.total)}</span></div>
            </div>

            <div className="cart-section">
              <div className="seg" role="tablist">
                {Object.entries(PAYMENT_METHODS).map(([k, label]) => (
                  <button key={k} role="tab" aria-selected={method === k} className={method === k ? 'is-on' : ''} onClick={() => setMethod(k)}>{label}</button>
                ))}
              </div>

              {method === 'cash' && (
                <>
                  <input className="big-input" inputMode="decimal" placeholder="Cash received" value={tendered} onChange={(e) => setTendered(e.target.value)} />
                  <div className="chips">
                    {quickCash.map((v) => <button key={v} className="chip" onClick={() => setTendered(String(v))}>{v === totals.total ? 'Exact' : peso(v)}</button>)}
                  </div>
                  <div className="sum-row sum-change"><span>Change</span><span>{pay.ok ? peso(pay.change) : '—'}</span></div>
                </>
              )}

              {method === 'gcash' && (
                <input className="big-input" placeholder="GCash reference no." value={reference} onChange={(e) => setReference(e.target.value)} />
              )}

              {method === 'credit' && (
                <div className="stack-sm">
                  <div className="row-inline">
                    <input placeholder="Name or ID — or scan the ID card" value={accountSearch} onChange={(e) => setAccountSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        const a = accounts.docs.find((x) => norm(x.idNumber) === norm(accountSearch));
                        if (a) { setAccountId(a.id); setAccountSearch(''); }
                      }} />
                    {cameraScanSupported() && <button className="btn btn-sm" type="button" onClick={() => { unlockAudio(); setCamera('account'); }} title="Scan ID with camera">Scan ID</button>}
                  </div>
                  <div className="account-pick">
                    {(account && !accountSearch ? [account] : matchingAccounts).map((a) => {
                      const avail = round2(Math.max((Number(a.limit) || 0) - (Number(a.balance) || 0), 0));
                      return (
                        <button key={a.id} className={`account-opt ${a.id === accountId ? 'is-on' : ''}`} onClick={() => setAccountId(a.id)}>
                          <span>{a.name} <span className="muted">· {a.idNumber}</span></span>
                          <span className="muted">Available {peso(avail)}</span>
                        </button>
                      );
                    })}
                    {!matchingAccounts.length && <span className="muted">No matching active accounts.</span>}
                  </div>
                </div>
              )}
            </div>

            {cart.length > 0 && !pay.ok && <div className="alert alert-warn">{pay.error}</div>}
            <button className="btn btn-primary btn-block btn-lg" disabled={!pay.ok || busy} onClick={checkout}>
              {busy ? 'Recording…' : `Charge ${peso(totals.total)}`}
            </button>
          </>
        )}
      </aside>

      {picking && <AddOnPicker product={picking} onClose={() => setPicking(null)} onAdd={(mods) => { addLine(picking, mods); setPicking(null); }} />}
      {camera === 'products' && (
        <CameraScanner title="Scan items" continuous paused={!!oversell || !!picking} onClose={() => setCamera(null)} onDetected={handleScan} />
      )}
      {camera === 'account' && (
        <CameraScanner title="Scan student / staff ID" onClose={() => setCamera(null)} onDetected={(code) => { setCamera(null); return handleScan(code); }} />
      )}
      {oversell && (
        <Modal title="⚠ Out of stock" onClose={() => setOversell(null)}
          footer={<>
            <button className="btn" onClick={() => setOversell(null)}>Don’t add</button>
            <button className="btn btn-danger" onClick={() => { addLine(oversell.p, oversell.mods, { confirmed: true }); setOversell(null); }}>Sell anyway</button>
          </>}>
          <div className="oos-warning">
            <strong>{oversell.p.name}</strong> has {oversell.avail <= 0 ? `${oversell.avail < 0 ? oversell.avail : 0} in stock` : `only ${oversell.avail} in stock`}
            {inCart(oversell.p.id) > 0 && <> and {inCart(oversell.p.id)} already in this order</>}.
          </div>
          <p className="muted small">You can still sell it — stock will go below zero until the next delivery or stock count. Check the shelf, or tell the inventory staff.</p>
        </Modal>
      )}
      {receipt && (
        <ReceiptModal sale={receipt} fresh onClose={() => { setReceipt(null); reset(); }} onNew={() => { setReceipt(null); reset(); }} />
      )}
    </div>
  );
}

function AddOnPicker({ product, onClose, onAdd }) {
  const [chosen, setChosen] = useState([]);
  const price = linePricing(product, chosen).unitPrice;
  const toggle = (name) => setChosen((c) => (c.includes(name) ? c.filter((x) => x !== name) : [...c, name]));
  return (
    <Modal title={product.name} onClose={onClose}
      footer={<><button className="btn" onClick={() => onAdd([])}>No add-ons</button><button className="btn btn-primary" onClick={() => onAdd(chosen)}>Add · {peso(price)}</button></>}>
      <p className="muted small">Choose add-ons (optional).</p>
      <div className="addon-grid">
        {product.modifiers.map((m) => (
          <button key={m.name} type="button" className={`addon ${chosen.includes(m.name) ? 'is-on' : ''}`} onClick={() => toggle(m.name)}>
            <span>{m.name}</span>
            <span className="muted">+{peso(m.price)}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

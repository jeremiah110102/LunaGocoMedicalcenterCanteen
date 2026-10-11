import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, addDoc, collection, deleteDoc, doc, serverTimestamp, updateDoc } from '../db';
import { useAuth } from '../context/AuthContext';
import { useCollection, byId } from '../hooks/useCollection';
import { Badge, Empty, ErrorNote, Field, Modal, PageHead, Stat, useToast } from '../components/ui';
import { availableCount, round2 } from '../lib/checkout';
import { peso, qty } from '../lib/format';
import { logAudit } from '../lib/audit';
import { changeStock } from '../services/inventory';
import { can } from '../lib/roles';
import { deleteProductImage, imagesEnabled, uploadProductImage } from '../db/storage';
import { downloadProductTemplate, readProductFile, runProductImport } from '../services/productImport';

export const PRODUCT_TYPES = { meal: 'Meal', snack: 'Snack', drink: 'Drink', combo: 'Meal set', other: 'Other' };

const blank = { name: '', sku: '', barcode: '', categoryId: '', type: 'meal', unit: 'pc', price: '', cost: '', trackStock: false, stock: '', lowStock: '5', recipe: [], modifiers: [], components: [] };

export default function Products() {
  const { profile } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const canOrder = can(profile, 'purchasing');
  const products = useCollection(() => collection(db, 'products'), []);
  const categories = useCollection(() => collection(db, 'categories'), []);
  const ingredients = useCollection(() => collection(db, 'ingredients'), []);
  const [editing, setEditing] = useState(null);
  const [showCats, setShowCats] = useState(false);
  const [importing, setImporting] = useState(false);
  const [filter, setFilter] = useState({ q: '', cat: 'all', type: 'all', archived: false });

  const catById = byId(categories.docs);
  const ingById = useMemo(() => byId(ingredients.docs), [ingredients.docs]);
  const prodById = useMemo(() => byId(products.docs), [products.docs]);

  const rows = products.docs
    .filter((p) => !!p.archived === filter.archived)
    .filter((p) => filter.cat === 'all' || p.categoryId === filter.cat)
    .filter((p) => filter.type === 'all' || p.type === filter.type)
    .filter((p) => {
      const s = filter.q.trim().toLowerCase();
      return !s || p.name.toLowerCase().includes(s) || (p.sku || '').toLowerCase().includes(s);
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const update = async (p, patch, action) => {
    try {
      await updateDoc(doc(db, 'products', p.id), { ...patch, updatedAt: serverTimestamp() });
      await logAudit(profile, action, { productId: p.id, name: p.name, ...patch });
      toast('Saved.');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <PageHead title="Products" sub="Meals, snacks and drinks on the menu">
        <button className="btn" onClick={() => setShowCats(true)}>Categories</button>
        <button className="btn" onClick={() => setImporting(true)}>Import from Excel</button>
        <button className="btn btn-primary" onClick={() => setEditing({ ...blank })}>Add product</button>
      </PageHead>

      <div className="filters">
        <input className="search" placeholder="Search name or SKU" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
        <select value={filter.cat} onChange={(e) => setFilter({ ...filter, cat: e.target.value })}>
          <option value="all">All categories</option>
          {categories.docs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}>
          <option value="all">All types</option>
          {Object.entries(PRODUCT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={filter.archived} onChange={(e) => setFilter({ ...filter, archived: e.target.checked })} /> Show archived</label>
      </div>

      <ErrorNote error={products.error} />
      <div className="card table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>SKU</th><th>Category</th><th className="num">Price</th><th className="num">Cost</th><th>Stock</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const avail = availableCount(p, ingById, prodById);
              return (
                <tr key={p.id}>
                  <td>
                    <div className="with-thumb">
                      {p.imageUrl ? <img className="thumb" src={p.imageUrl} alt="" loading="lazy" /> : <span className="thumb thumb-empty" aria-hidden />}
                      <div><strong>{p.name}</strong><div className="muted small">{PRODUCT_TYPES[p.type]} · {p.unit}</div></div>
                    </div>
                  </td>
                  <td className="mono">{p.sku}</td>
                  <td>{catById[p.categoryId]?.name || '—'}</td>
                  <td className="num">{peso(p.price)}</td>
                  <td className="num">{peso(p.cost)}</td>
                  <td>
                    {p.trackStock ? qty(p.stock) : p.type === 'combo' ? `Meal set (${Number.isFinite(avail) ? avail : '∞'} available)` : p.recipe?.length ? `Recipe (${Number.isFinite(avail) ? avail : '∞'} can be made)` : 'Not tracked'}
                    {(p.modifiers || []).length > 0 && <div className="muted small">{p.modifiers.length} add-on(s)</div>}
                  </td>
                  <td>
                    {p.archived ? <Badge>Archived</Badge> : p.soldOut ? <Badge kind="bad">Sold out</Badge> : avail <= 0 ? <Badge kind="bad">No stock</Badge> : Number.isFinite(avail) && avail <= (Number(p.lowStock) || 0) ? <Badge kind="warn">Low</Badge> : <Badge kind="ok">Available</Badge>}
                  </td>
                  <td className="row-actions">
                    <button className="btn btn-sm" onClick={() => setEditing({ ...blank, ...p, price: String(p.price), cost: String(p.cost ?? ''), lowStock: String(p.lowStock ?? ''), recipe: p.recipe || [], modifiers: (p.modifiers || []).map((m) => ({ ...m, price: String(m.price) })), components: p.components || [] })}>Edit</button>
                    {canOrder && p.trackStock && !p.archived && (
                      <button className="btn btn-sm" onClick={() => navigate(`/purchasing?product=${p.id}`)}>Order</button>
                    )}
                    {!p.archived && (
                      <button className="btn btn-sm" onClick={() => update(p, { soldOut: !p.soldOut }, p.soldOut ? 'product.available' : 'product.soldOut')}>
                        {p.soldOut ? 'Available' : 'Sold out'}
                      </button>
                    )}
                    <button className="btn btn-sm btn-ghost" onClick={() => update(p, { archived: !p.archived }, p.archived ? 'product.unarchive' : 'product.archive')}>
                      {p.archived ? 'Restore' : 'Archive'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!products.loading && !rows.length && <Empty>No products match.</Empty>}
      </div>

      {editing && (
        <ProductForm
          initial={editing}
          products={products.docs}
          categories={categories.docs}
          ingredients={ingredients.docs.filter((i) => !i.archived)}
          canOrder={canOrder}
          onClose={() => setEditing(null)}
          onOrder={(id) => navigate(`/purchasing?product=${id}`)}
        />
      )}
      {importing && <ImportProducts products={products.docs} categories={categories.docs} onClose={() => setImporting(false)} />}
      {showCats && <CategoryManager categories={categories.docs} products={products.docs} onClose={() => setShowCats(false)} />}
    </>
  );
}

function ProductForm({ initial, products, categories, ingredients, canOrder, onClose, onOrder }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [f, setF] = useState(initial);
  const [photo, setPhoto] = useState(null); // { file, preview } | { remove: true } | null
  const [orderAfter, setOrderAfter] = useState(false);
  const shownImage = photo?.preview || (photo?.remove ? '' : initial.imageUrl || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const isNew = !initial.id;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const recipeCost = round2(
    (f.recipe || []).reduce((s, r) => s + (Number(ingredients.find((i) => i.id === r.ingredientId)?.cost) || 0) * (Number(r.qty) || 0), 0),
  );

  const save = async (e) => {
    e.preventDefault();
    setErr('');
    const price = Number(f.price);
    const cost = f.cost === '' ? 0 : Number(f.cost);
    const sku = f.sku.trim().toUpperCase();
    if (!f.name.trim()) return setErr('Name is required.');
    if (!(price >= 0) || f.price === '') return setErr('Enter a valid selling price.');
    if (!(cost >= 0)) return setErr('Cost must be zero or more.');
    if (sku && products.some((p) => p.id !== f.id && (p.sku || '').toUpperCase() === sku)) return setErr(`SKU ${sku} is already used.`);
    const recipe = (f.recipe || []).filter((r) => r.ingredientId && Number(r.qty) > 0).map((r) => ({ ingredientId: r.ingredientId, qty: Number(r.qty) }));
    if (new Set(recipe.map((r) => r.ingredientId)).size !== recipe.length) return setErr('Each ingredient can appear only once in the recipe.');
    const barcode = String(f.barcode || '').trim();
    if (barcode && products.some((p) => p.id !== f.id && String(p.barcode || '').trim() === barcode)) return setErr(`Barcode ${barcode} is already used by another product.`);
    const modifiers = [];
    for (const m of f.modifiers || []) {
      const name = String(m.name || '').trim();
      if (!name) continue;
      if (modifiers.some((x) => x.name.toLowerCase() === name.toLowerCase())) return setErr(`Add-on "${name}" is listed twice.`);
      const mp = Number(m.price);
      if (!(mp >= 0) || m.price === '') return setErr(`Enter a price for add-on "${name}" (0 if free).`);
      modifiers.push({ name, price: round2(mp), recipe: (m.recipe || []).filter((r) => r.ingredientId && Number(r.qty) > 0).map((r) => ({ ingredientId: r.ingredientId, qty: Number(r.qty) })) });
    }
    const components = f.type === 'combo' ? (f.components || []).filter((c) => c.productId && Number(c.qty) > 0).map((c) => ({ productId: c.productId, qty: Math.floor(Number(c.qty)) })) : [];
    if (f.type === 'combo' && !components.length) return setErr('A meal set needs at least one item.');
    if (components.some((c) => c.productId === f.id)) return setErr('A meal set can’t contain itself.');
    if (components.some((c) => products.find((p) => p.id === c.productId)?.type === 'combo')) return setErr('A meal set can’t contain another meal set.');

    const data = {
      name: f.name.trim(),
      sku,
      barcode,
      categoryId: f.categoryId || '',
      type: f.type,
      unit: f.unit.trim() || 'pc',
      price: round2(price),
      cost: round2(cost),
      trackStock: !!f.trackStock,
      lowStock: Number(f.lowStock) || 0,
      recipe,
      modifiers,
      components,
      updatedAt: serverTimestamp(),
    };
    setBusy(true);
    let newId = null;
    try {
      if (photo?.file) Object.assign(data, await uploadProductImage(photo.file));
      else if (photo?.remove) Object.assign(data, { imageUrl: '', imagePath: '' });
      if (isNew) {
        const opening = Number(f.stock) || 0;
        const ref = await addDoc(collection(db, 'products'), { ...data, stock: 0, soldOut: false, archived: false, createdAt: serverTimestamp() });
        newId = ref.id;
        if (data.trackStock && opening > 0) await changeStock({ itemType: 'product', itemId: ref.id, change: opening, reason: 'initial', note: 'Opening stock', profile });
        await logAudit(profile, 'product.create', { productId: ref.id, name: data.name, price: data.price });
      } else {
        await updateDoc(doc(db, 'products', f.id), data);
        const priceChanged = Number(initial.price) !== data.price;
        await logAudit(profile, priceChanged ? 'product.priceChange' : 'product.update', {
          productId: f.id, name: data.name, ...(priceChanged ? { from: Number(initial.price), to: data.price } : {}),
        });
      }
    } catch (e2) {
      setErr(e2.message);
      setBusy(false);
      return;
    }
    if ((photo?.file || photo?.remove) && initial.imagePath) deleteProductImage(initial.imagePath);
    setBusy(false);
    onClose();
    if (newId && orderAfter && data.trackStock) {
      toast('Product added. Now fill in its purchase order.');
      onOrder(newId);
    } else {
      toast(isNew ? 'Product added.' : 'Product updated.');
    }
  };

  return (
    <Modal
      wide
      title={isNew ? 'Add product' : `Edit ${initial.name}`}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="pform" disabled={busy}>Save</button></>}
    >
      <form id="pform" onSubmit={save} className="grid-2">
        {err && <div className="alert alert-error span-2">{err}</div>}
        <Field label="Name"><input value={f.name} onChange={set('name')} required /></Field>
        <Field label="SKU" hint="Optional, must be unique"><input value={f.sku} onChange={set('sku')} /></Field>
        <Field label="Barcode" hint="Scan it here to fill in (packed drinks and snacks)"><input value={f.barcode || ''} onChange={set('barcode')} onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()} /></Field>
        <Field label="Category">
          <select value={f.categoryId} onChange={set('categoryId')}>
            <option value="">— None —</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select value={f.type} onChange={set('type')}>
            {Object.entries(PRODUCT_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Selling price (₱)"><input inputMode="decimal" value={f.price} onChange={set('price')} required /></Field>
        <Field label="Cost (₱)" hint={recipeCost > 0 ? `Recipe ingredients cost ${peso(recipeCost)}` : 'Used for profit reports'}>
          <input inputMode="decimal" value={f.cost} onChange={set('cost')} />
        </Field>
        <Field label="Unit"><input value={f.unit} onChange={set('unit')} placeholder="pc, bottle, plate" /></Field>
        <Field label="Low-stock alert at"><input inputMode="numeric" value={f.lowStock} onChange={set('lowStock')} /></Field>

        <div className="span-2 box">
          <label className="check"><input type="checkbox" checked={f.trackStock} onChange={set('trackStock')} /> Track stock for this product (bottled drinks, packed snacks)</label>
          {f.trackStock && isNew && <Field label="Opening stock" hint="Stock you already have on hand"><input inputMode="decimal" value={f.stock} onChange={set('stock')} /></Field>}
          {f.trackStock && isNew && canOrder && (
            <label className="check"><input type="checkbox" checked={orderAfter} onChange={(e) => setOrderAfter(e.target.checked)} /> Create a purchase order for this product after saving</label>
          )}
          {f.trackStock && !isNew && <p className="muted small">Current stock: {qty(initial.stock)}. Change stock from the Inventory page so every change is recorded.</p>}
        </div>

        <div className="span-2 box">
          <strong>Photo <span className="muted small">(optional)</span></strong>
          <div className="photo-row">
            {shownImage ? <img className="photo-preview" src={shownImage} alt="" /> : <div className="photo-preview photo-empty">No photo</div>}
            {imagesEnabled() ? (
              <div className="stack-sm">
                <label className="btn btn-sm file-btn">
                  {shownImage ? 'Change photo' : 'Add photo'}
                  <input type="file" accept="image/*" hidden onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) setPhoto({ file, preview: URL.createObjectURL(file) });
                  }} />
                </label>
                {shownImage && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPhoto({ remove: true })}>Remove photo</button>}
                <span className="muted small">Resized to 640 px and stored in Supabase.</span>
              </div>
            ) : (
              <p className="muted small">Product photos are available when the database is <strong>Supabase</strong> (Settings → Database).</p>
            )}
          </div>
        </div>

        {f.type === 'combo' && (
          <div className="span-2 box">
            <div className="row-between">
              <strong>Meal set contents</strong>
              <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, components: [...(f.components || []), { productId: '', qty: 1 }] })}>Add item</button>
            </div>
            <p className="muted small">Selling the set deducts each item’s stock and recipe. Set the meal-set price above.</p>
            {(f.components || []).map((c, i) => (
              <div className="recipe-row" key={i}>
                <select value={c.productId} onChange={(e) => setF({ ...f, components: f.components.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)) })}>
                  <option value="">Choose product</option>
                  {products.filter((p) => !p.archived && p.type !== 'combo' && p.id !== f.id).map((p) => <option key={p.id} value={p.id}>{p.name} ({peso(p.price)})</option>)}
                </select>
                <input inputMode="numeric" placeholder="Qty" value={c.qty} onChange={(e) => setF({ ...f, components: f.components.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)) })} />
                <span />
                <button type="button" className="icon-btn" onClick={() => setF({ ...f, components: f.components.filter((_, j) => j !== i) })} aria-label="Remove">×</button>
              </div>
            ))}
          </div>
        )}

        <div className="span-2 box">
          <div className="row-between">
            <strong>Add-ons</strong>
            <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, modifiers: [...(f.modifiers || []), { name: '', price: '', recipe: [] }] })}>Add add-on</button>
          </div>
          <p className="muted small">Extras the cashier can pick, e.g. “Extra rice +₱10”, “Egg +₱15”. Optionally link an ingredient so its stock is deducted.</p>
          {(f.modifiers || []).map((m, i) => {
            const setM = (patch) => setF({ ...f, modifiers: f.modifiers.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            const r = (m.recipe || [])[0] || { ingredientId: '', qty: '' };
            return (
              <div className="addon-row" key={i}>
                <input placeholder="Add-on name" value={m.name} onChange={(e) => setM({ name: e.target.value })} />
                <input inputMode="decimal" placeholder="+₱" value={m.price} onChange={(e) => setM({ price: e.target.value })} />
                <select value={r.ingredientId} onChange={(e) => setM({ recipe: e.target.value ? [{ ingredientId: e.target.value, qty: r.qty || 1 }] : [] })}>
                  <option value="">No stock deduction</option>
                  {ingredients.map((x) => <option key={x.id} value={x.id}>Uses {x.name} ({x.unit})</option>)}
                </select>
                <input inputMode="decimal" placeholder="Qty" disabled={!r.ingredientId} value={r.ingredientId ? r.qty : ''} onChange={(e) => setM({ recipe: [{ ingredientId: r.ingredientId, qty: e.target.value }] })} />
                <button type="button" className="icon-btn" onClick={() => setF({ ...f, modifiers: f.modifiers.filter((_, j) => j !== i) })} aria-label="Remove">×</button>
              </div>
            );
          })}
        </div>

        <div className="span-2 box">
          <div className="row-between">
            <strong>Recipe</strong>
            <button type="button" className="btn btn-sm" onClick={() => setF({ ...f, recipe: [...(f.recipe || []), { ingredientId: '', qty: '' }] })}>Add ingredient</button>
          </div>
          <p className="muted small">Ingredients used per 1 {f.unit || 'pc'}. They are deducted automatically when this product is sold.</p>
          {(f.recipe || []).map((r, i) => {
            const ing = ingredients.find((x) => x.id === r.ingredientId);
            return (
              <div className="recipe-row" key={i}>
                <select value={r.ingredientId} onChange={(e) => setF({ ...f, recipe: f.recipe.map((x, j) => (j === i ? { ...x, ingredientId: e.target.value } : x)) })}>
                  <option value="">Choose ingredient</option>
                  {ingredients.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.unit})</option>)}
                </select>
                <input inputMode="decimal" placeholder="Qty" value={r.qty} onChange={(e) => setF({ ...f, recipe: f.recipe.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)) })} />
                <span className="muted small">{ing?.unit}</span>
                <button type="button" className="icon-btn" onClick={() => setF({ ...f, recipe: f.recipe.filter((_, j) => j !== i) })} aria-label="Remove">×</button>
              </div>
            );
          })}
        </div>
      </form>
    </Modal>
  );
}

function CategoryManager({ categories, products, onClose }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [name, setName] = useState('');
  const [edit, setEdit] = useState({});

  const add = async (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    if (categories.some((c) => c.name.toLowerCase() === n.toLowerCase())) return toast('That category already exists.', 'error');
    try {
      await addDoc(collection(db, 'categories'), { name: n, createdAt: serverTimestamp() });
      await logAudit(profile, 'category.create', { name: n });
      setName('');
    } catch (e2) {
      toast(e2.message, 'error');
    }
  };

  const rename = async (c) => {
    const n = (edit[c.id] || '').trim();
    if (!n || n === c.name) return;
    try {
      await updateDoc(doc(db, 'categories', c.id), { name: n });
      await logAudit(profile, 'category.rename', { id: c.id, from: c.name, to: n });
      toast('Renamed.');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  const remove = async (c) => {
    const used = products.filter((p) => p.categoryId === c.id).length;
    if (used) return toast(`${used} product(s) still use "${c.name}". Move them first.`, 'error');
    if (!confirm(`Delete category "${c.name}"?`)) return;
    try {
      await deleteDoc(doc(db, 'categories', c.id));
      await logAudit(profile, 'category.delete', { id: c.id, name: c.name });
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <Modal title="Categories" onClose={onClose}>
      <form onSubmit={add} className="row-inline">
        <input placeholder="New category, e.g. Rice meals" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn btn-primary">Add</button>
      </form>
      <ul className="plain-list">
        {categories.map((c) => (
          <li key={c.id} className="row-inline">
            <input defaultValue={c.name} onChange={(e) => setEdit({ ...edit, [c.id]: e.target.value })} onBlur={() => rename(c)} />
            <span className="muted small">{products.filter((p) => p.categoryId === c.id).length} products</span>
            <button className="btn btn-sm btn-ghost" onClick={() => remove(c)}>Delete</button>
          </li>
        ))}
      </ul>
      {!categories.length && <Empty>No categories yet.</Empty>}
    </Modal>
  );
}

function ImportProducts({ products, categories, onClose }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [plan, setPlan] = useState(null);
  const [file, setFile] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(null);

  const pick = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setFile(f.name);
    setBusy('read');
    setPlan(await readProductFile(f, { products, categories }));
    setBusy('');
  };
  const run = async () => {
    setBusy('import');
    try {
      const r = await runProductImport(plan, profile, (done, total) => setProgress({ done, total }));
      toast(`Imported: ${r.created} new, ${r.updated} updated${r.categories ? `, ${r.categories} new categories` : ''}.`);
      onClose();
    } catch (e) {
      toast(`Import stopped: ${e.message}`, 'error');
      setBusy('');
    }
  };
  const creates = plan?.items.filter((i) => i.action === 'create') || [];
  const updates = plan?.items.filter((i) => i.action === 'update') || [];
  return (
    <Modal wide title="Import products from Excel" onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!plan?.items.length || !!busy} onClick={run}>
            {busy === 'import' ? 'Importing…' : plan?.items.length ? `Import ${plan.items.length} product(s)` : 'Import'}
          </button>
        </>
      }>
      <ol className="steps">
        <li className={plan ? 'done' : ''}>
          <strong>Download the template and fill it in</strong>
          <button className="btn btn-sm" onClick={() => downloadProductTemplate(categories)}>Download Excel template</button>
          <span className="muted small">Name and Selling price are required. Matching SKU, barcode or name updates an existing product.</span>
        </li>
        <li className={plan ? (plan.items.length ? 'done' : 'bad') : ''}>
          <strong>Choose the filled-in file</strong>
          <label className="btn btn-sm file-btn">
            {busy === 'read' ? 'Checking…' : 'Choose .xlsx or .csv'}
            <input type="file" accept=".xlsx,.csv" hidden onChange={pick} disabled={!!busy} />
          </label>
          {file && <span className="muted small">{file}</span>}
        </li>
      </ol>

      {plan && (
        <>
          <div className="stats mt">
            <Stat label="New products" value={creates.length} />
            <Stat label="Updates" value={updates.length} />
            <Stat label="New categories" value={plan.newCategories.length} sub={plan.newCategories.join(', ') || undefined} />
            <Stat label="Rows with problems" value={plan.errors.length} kind={plan.errors.length ? 'warn' : undefined} />
          </div>
          {plan.errors.length > 0 && (
            <div className="alert alert-error">
              These rows will be skipped — fix them in the file and choose it again, or import the rest:{'\n'}
              {plan.errors.slice(0, 15).join('\n')}{plan.errors.length > 15 ? `\n…and ${plan.errors.length - 15} more` : ''}
            </div>
          )}
          <div className="table-wrap">
            <table>
              <thead><tr><th>Row</th><th>Action</th><th>Name</th><th>Category</th><th className="num">Price</th><th>Stock</th><th>Notes</th></tr></thead>
              <tbody>
                {plan.items.slice(0, 200).map((it) => (
                  <tr key={it.line}>
                    <td>{it.line}</td>
                    <td>{it.action === 'create' ? <Badge kind="ok">New</Badge> : <Badge kind="info">Update</Badge>}</td>
                    <td>{it.data.name}{it.action === 'update' && it.existingName !== it.data.name && <div className="muted small">was {it.existingName}</div>}</td>
                    <td>{it.categoryName ? `${it.categoryName} (new)` : categories.find((c) => c.id === it.categoryId)?.name || '—'}</td>
                    <td className="num">{peso(it.data.price)}</td>
                    <td>{it.action === 'create' ? (it.data.trackStock ? qty(it.openingStock) : 'Not tracked') : '—'}</td>
                    <td className="small">{it.warnings.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {progress && <progress max={progress.total} value={progress.done} />}
        </>
      )}
    </Modal>
  );
}

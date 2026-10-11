import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { can } from '../lib/roles';
import { db, addDoc, collection, doc, serverTimestamp, updateDoc } from '../db';
import { useAuth } from '../context/AuthContext';
import { useCollection } from '../hooks/useCollection';
import { Badge, Empty, ErrorNote, Field, Modal, PageHead, useToast } from '../components/ui';
import { round2 } from '../lib/checkout';
import { peso, qty } from '../lib/format';
import { logAudit } from '../lib/audit';
import { changeStock } from '../services/inventory';

const blank = { name: '', unit: 'kg', cost: '', lowStock: '', stock: '' };

export default function Ingredients() {
  const { profile } = useAuth();
  const toast = useToast();
  const ingredients = useCollection(() => collection(db, 'ingredients'), []);
  const products = useCollection(() => collection(db, 'products'), []);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [q, setQ] = useState('');

  const usedIn = (id) => products.docs.filter((p) => !p.archived && (p.recipe || []).some((r) => r.ingredientId === id));

  const rows = ingredients.docs
    .filter((i) => !!i.archived === showArchived)
    .filter((i) => !q.trim() || i.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  const toggleArchive = async (i) => {
    if (!i.archived && usedIn(i.id).length) {
      return toast(`Used in ${usedIn(i.id).map((p) => p.name).join(', ')}. Remove it from those recipes first.`, 'error');
    }
    try {
      await updateDoc(doc(db, 'ingredients', i.id), { archived: !i.archived, updatedAt: serverTimestamp() });
      await logAudit(profile, i.archived ? 'ingredient.unarchive' : 'ingredient.archive', { id: i.id, name: i.name });
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <PageHead title="Ingredients" sub="Raw materials used in meal recipes">
        <button className="btn btn-primary" onClick={() => setEditing({ ...blank })}>Add ingredient</button>
      </PageHead>
      <div className="filters">
        <input className="search" placeholder="Search ingredients" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
      </div>
      <ErrorNote error={ingredients.error} />
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Ingredient</th><th className="num">Stock</th><th className="num">Unit cost</th><th className="num">Stock value</th><th>Used in</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((i) => {
              const low = Number(i.stock) <= Number(i.lowStock || 0);
              return (
                <tr key={i.id}>
                  <td><strong>{i.name}</strong></td>
                  <td className="num">{qty(i.stock)} {i.unit}</td>
                  <td className="num">{peso(i.cost)} / {i.unit}</td>
                  <td className="num">{peso((Number(i.stock) || 0) * (Number(i.cost) || 0))}</td>
                  <td className="small">{usedIn(i.id).map((p) => p.name).join(', ') || '—'}</td>
                  <td>{i.archived ? <Badge>Archived</Badge> : Number(i.stock) <= 0 ? <Badge kind="bad">Out</Badge> : low ? <Badge kind="warn">Low</Badge> : <Badge kind="ok">OK</Badge>}</td>
                  <td className="row-actions">
                    {can(profile, 'purchasing') && !i.archived && <button className="btn btn-sm" onClick={() => navigate(`/purchasing?ingredient=${i.id}`)}>Order</button>}
                    <button className="btn btn-sm" onClick={() => setEditing({ ...i, cost: String(i.cost ?? ''), lowStock: String(i.lowStock ?? '') })}>Edit</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => toggleArchive(i)}>{i.archived ? 'Restore' : 'Archive'}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!ingredients.loading && !rows.length && <Empty>No ingredients yet.</Empty>}
      </div>
      {editing && <IngredientForm initial={editing} all={ingredients.docs} onClose={() => setEditing(null)} />}
    </>
  );
}

function IngredientForm({ initial, all, onClose }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [f, setF] = useState(initial);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const isNew = !initial.id;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = async (e) => {
    e.preventDefault();
    const name = f.name.trim();
    if (!name) return setErr('Name is required.');
    if (all.some((i) => i.id !== f.id && i.name.toLowerCase() === name.toLowerCase())) return setErr('An ingredient with that name exists.');
    const cost = f.cost === '' ? 0 : Number(f.cost);
    if (!(cost >= 0)) return setErr('Cost must be zero or more.');
    const data = { name, unit: f.unit.trim() || 'pc', cost: round2(cost), lowStock: Number(f.lowStock) || 0, updatedAt: serverTimestamp() };
    setBusy(true);
    try {
      if (isNew) {
        const ref = await addDoc(collection(db, 'ingredients'), { ...data, stock: 0, archived: false, createdAt: serverTimestamp() });
        const opening = Number(f.stock) || 0;
        if (opening > 0) await changeStock({ itemType: 'ingredient', itemId: ref.id, change: opening, reason: 'initial', note: 'Opening stock', profile });
        await logAudit(profile, 'ingredient.create', { id: ref.id, name });
      } else {
        await updateDoc(doc(db, 'ingredients', f.id), data);
        await logAudit(profile, 'ingredient.update', { id: f.id, name });
      }
      toast('Saved.');
      onClose();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={isNew ? 'Add ingredient' : `Edit ${initial.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="iform" disabled={busy}>Save</button></>}>
      <form id="iform" onSubmit={save} className="grid-2">
        {err && <div className="alert alert-error span-2">{err}</div>}
        <Field label="Name"><input value={f.name} onChange={set('name')} required /></Field>
        <Field label="Unit" hint="kg, g, L, pc, cup…"><input value={f.unit} onChange={set('unit')} /></Field>
        <Field label="Cost per unit (₱)"><input inputMode="decimal" value={f.cost} onChange={set('cost')} /></Field>
        <Field label="Low-stock alert at"><input inputMode="decimal" value={f.lowStock} onChange={set('lowStock')} /></Field>
        {isNew ? (
          <Field label="Opening stock"><input inputMode="decimal" value={f.stock} onChange={set('stock')} /></Field>
        ) : (
          <p className="muted small span-2">Current stock: {qty(initial.stock)} {initial.unit}. Use the Inventory page to receive or adjust stock.</p>
        )}
      </form>
    </Modal>
  );
}

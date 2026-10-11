import { useState } from 'react';
import { db, collection, orderBy, query, where } from '../db';
import { useAuth } from '../context/AuthContext';
import { useCollection } from '../hooks/useCollection';
import { useShift } from '../hooks/useShift';
import { BarList, Badge, Empty, ErrorNote, Field, Modal, PageHead, Stat, useToast } from '../components/ui';
import { EXPENSE_CATEGORIES } from '../lib/inventoryMath';
import { dayKey, fmtDate, peso } from '../lib/format';
import { addExpense, voidExpense } from '../services/counts';
import { addCashEvent } from '../services/shifts';
import { PAYMENT_METHODS_SUPPLIER } from '../services/payables';

const monthStart = () => {
  const d = new Date();
  return dayKey(new Date(d.getFullYear(), d.getMonth(), 1));
};

export default function Expenses() {
  const { profile } = useAuth();
  const toast = useToast();
  const { shift } = useShift();
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(dayKey(new Date()));
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState(null);
  const [showVoided, setShowVoided] = useState(false);
  const canVoid = ['admin', 'manager'].includes(profile.role);

  const list = useCollection(() => query(collection(db, 'expenses'), where('date', '>=', from), where('date', '<=', to), orderBy('date', 'desc')), [from, to]);
  const rows = list.docs.filter((e) => showVoided || !e.voided);
  const live = list.docs.filter((e) => !e.voided);
  const total = live.reduce((t, e) => t + Number(e.amount), 0);
  const byCat = Object.entries(live.reduce((m, e) => ({ ...m, [e.category]: (m[e.category] || 0) + Number(e.amount) }), {})).sort((a, b) => b[1] - a[1]);

  return (
    <>
      <PageHead title="Expenses" sub="Gas, utilities, wages and other costs — used for the profit report">
        <button className="btn btn-primary" onClick={() => setAdding(true)}>Add expense</button>
      </PageHead>
      <div className="filters">
        <label className="field-inline">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field-inline">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={showVoided} onChange={(e) => setShowVoided(e.target.checked)} /> Show voided</label>
      </div>
      <div className="stats">
        <Stat label="Total expenses" value={peso(total)} kind="accent" sub={`${live.length} entries`} />
        <Stat label="Paid from cash drawer" value={peso(live.filter((e) => e.fromDrawer).reduce((t, e) => t + Number(e.amount), 0))} />
      </div>
      <div className="grid-dash">
        <section className="card table-wrap">
          <ErrorNote error={list.error} />
          <table>
            <thead><tr><th>Date</th><th>Category</th><th>Paid to</th><th>How</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={e.voided ? 'row-muted' : ''}>
                  <td>{fmtDate(e.date)}</td>
                  <td>{e.category}{e.notes && <div className="muted small">{e.notes}</div>}</td>
                  <td>{e.paidTo || '—'}</td>
                  <td>{e.fromDrawer ? <Badge kind="warn">Cash drawer</Badge> : PAYMENT_METHODS_SUPPLIER[e.method] || e.method}</td>
                  <td className="num">{e.voided ? <s>{peso(e.amount)}</s> : peso(e.amount)}</td>
                  <td className="row-actions">
                    {e.voided ? <span className="muted small">Voided: {e.voidReason}</span> : canVoid && <button className="btn btn-sm btn-ghost" onClick={() => setVoiding(e)}>Void</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!list.loading && !rows.length && <Empty>No expenses in this period.</Empty>}
        </section>
        <section className="card">
          <h2>By category</h2>
          <BarList rows={byCat.map(([k, v]) => ({ label: k, value: v, display: peso(v) }))} emptyText="No expenses yet." />
        </section>
      </div>

      {adding && <AddExpense shift={shift} onClose={() => setAdding(false)} />}
      {voiding && (
        <VoidExpense expense={voiding} onClose={() => setVoiding(null)}
          onVoid={async (reason) => {
            try {
              await voidExpense(voiding, reason, profile);
              toast('Expense voided.');
              setVoiding(null);
            } catch (err) {
              toast(err.message, 'error');
            }
          }} />
      )}
    </>
  );
}

function AddExpense({ shift, onClose }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ date: dayKey(new Date()), category: EXPENSE_CATEGORIES[0], amount: '', method: 'cash', paidTo: '', notes: '', fromDrawer: false });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async () => {
    setBusy(true);
    try {
      await addExpense({ ...f, shift, profile }, addCashEvent);
      toast(f.fromDrawer ? 'Expense saved and taken out of the cash drawer.' : 'Expense saved.');
      onClose();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Add expense" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}>Save</button></>}>
      <div className="grid-2">
        <Field label="Date"><input type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label="Category">
          <select value={f.category} onChange={set('category')}>{EXPENSE_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
        </Field>
        <Field label="Amount (₱)"><input inputMode="decimal" value={f.amount} onChange={set('amount')} /></Field>
        <Field label="Paid to"><input value={f.paidTo} onChange={set('paidTo')} placeholder="Supplier, person, utility…" /></Field>
        {!f.fromDrawer && (
          <Field label="Paid by">
            <select value={f.method} onChange={set('method')}>{Object.entries(PAYMENT_METHODS_SUPPLIER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          </Field>
        )}
        <Field label="Notes"><input value={f.notes} onChange={set('notes')} /></Field>
        <label className="check span-2">
          <input type="checkbox" checked={f.fromDrawer} disabled={!shift} onChange={set('fromDrawer')} />
          Paid with cash from my drawer {shift ? `(${shift.shiftNo})` : '— open a shift first'}
        </label>
      </div>
    </Modal>
  );
}

function VoidExpense({ expense, onClose, onVoid }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={`Void ${expense.category} · ${peso(expense.amount)}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-danger" onClick={() => onVoid(reason)}>Void</button></>}>
      <Field label="Reason"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Entered twice, wrong amount…" /></Field>
      {expense.fromDrawer && <p className="muted small">This was paid from a cash drawer; voiding doesn’t change that shift’s count.</p>}
    </Modal>
  );
}

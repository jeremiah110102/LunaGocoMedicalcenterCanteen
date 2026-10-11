import { useState } from 'react';
import { db, addDoc, collection, doc, query, serverTimestamp, updateDoc, where } from '../db';
import { useAuth } from '../context/AuthContext';
import { useCollection } from '../hooks/useCollection';
import { Badge, Empty, ErrorNote, Field, Modal, PageHead, Stat, useToast } from '../components/ui';
import { canManageCredit } from '../lib/roles';
import { round2 } from '../lib/checkout';
import { fmtDateTime, peso, toDate } from '../lib/format';
import { logAudit } from '../lib/audit';
import { recordRepayment } from '../services/credit';
import { CreditExtrasButtons, StatementModal, QrCards } from './CreditExtras';
import { useShift } from '../hooks/useShift';

const TYPES = { student: 'Student', staff: 'Staff' };

export default function Credit() {
  const { profile } = useAuth();
  const accounts = useCollection(() => collection(db, 'creditAccounts'), []);
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [onlyOwing, setOnlyOwing] = useState(false);
  const [editing, setEditing] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [qrFor, setQrFor] = useState(null);
  const manage = canManageCredit(profile);

  const s = q.trim().toLowerCase();
  const rows = accounts.docs
    .filter((a) => type === 'all' || a.type === type)
    .filter((a) => !onlyOwing || Number(a.balance) > 0)
    .filter((a) => !s || a.name.toLowerCase().includes(s) || (a.idNumber || '').toLowerCase().includes(s))
    .sort((a, b) => (Number(b.balance) || 0) - (Number(a.balance) || 0) || a.name.localeCompare(b.name));

  const outstanding = accounts.docs.reduce((t, a) => t + (Number(a.balance) || 0), 0);
  const owing = accounts.docs.filter((a) => Number(a.balance) > 0).length;
  const open = accounts.docs.find((a) => a.id === openId);

  return (
    <>
      <PageHead title="Credit accounts" sub="Students and staff allowed to buy on credit">
        <button className="btn" onClick={() => window.print()}>Print balances</button>
        <CreditExtrasButtons accounts={accounts.docs} manage={manage} onQrAll={() => setQrFor(rows)} />
        {manage && <button className="btn btn-primary" onClick={() => setEditing({ name: '', idNumber: '', type: 'student', limit: '500', active: true })}>Add account</button>}
      </PageHead>

      <div className="stats">
        <Stat label="Total outstanding" value={peso(outstanding)} kind={outstanding > 0 ? 'warn' : undefined} />
        <Stat label="Accounts with balance" value={owing} />
        <Stat label="Accounts" value={accounts.docs.length} />
      </div>

      <div className="filters no-print">
        <input className="search" placeholder="Name or ID number" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">Students and staff</option>
          {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={onlyOwing} onChange={(e) => setOnlyOwing(e.target.checked)} /> Only with balance</label>
      </div>

      <ErrorNote error={accounts.error} />
      <div className="card table-wrap printable">
        <h2 className="print-only">Outstanding credit balances — {new Date().toLocaleDateString()}</h2>
        <table>
          <thead><tr><th>Name</th><th>ID no.</th><th>Type</th><th className="num">Balance</th><th className="num">Limit</th><th className="num">Available</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id} className="clickable" onClick={() => setOpenId(a.id)}>
                <td><strong>{a.name}</strong></td>
                <td className="mono">{a.idNumber}</td>
                <td>{TYPES[a.type]}</td>
                <td className="num">{peso(a.balance)}</td>
                <td className="num">{peso(a.limit)}</td>
                <td className="num">{peso(Math.max((Number(a.limit) || 0) - (Number(a.balance) || 0), 0))}</td>
                <td>{a.active === false ? <Badge>Disabled</Badge> : Number(a.balance) >= Number(a.limit) ? <Badge kind="bad">At limit</Badge> : <Badge kind="ok">Active</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!accounts.loading && !rows.length && <Empty>No accounts match.</Empty>}
      </div>

      {editing && <AccountForm initial={editing} all={accounts.docs} onClose={() => setEditing(null)} />}
      {open && <AccountDetail account={open} manage={manage} onQr={() => setQrFor([open])} onEdit={() => { setEditing({ ...open, limit: String(open.limit) }); setOpenId(null); }} onClose={() => setOpenId(null)} />}
      {qrFor && <QrCards accounts={qrFor} onClose={() => setQrFor(null)} />}
    </>
  );
}

function AccountForm({ initial, all, onClose }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [f, setF] = useState(initial);
  const [err, setErr] = useState('');
  const isNew = !initial.id;

  const save = async (e) => {
    e.preventDefault();
    const name = f.name.trim();
    const idNumber = f.idNumber.trim();
    const limit = round2(Number(f.limit));
    if (!name || !idNumber) return setErr('Name and ID number are required.');
    if (!(limit >= 0)) return setErr('Credit limit must be zero or more.');
    if (all.some((a) => a.id !== f.id && (a.idNumber || '').toLowerCase() === idNumber.toLowerCase())) return setErr('That ID number already has an account.');
    const data = {
      name, idNumber, type: f.type, limit, active: !!f.active,
      email: String(f.email || '').trim(),
      guardianName: f.type === 'student' ? String(f.guardianName || '').trim() : '',
      guardianPhone: f.type === 'student' ? String(f.guardianPhone || '').trim() : '',
      guardianEmail: f.type === 'student' ? String(f.guardianEmail || '').trim() : '',
      updatedAt: serverTimestamp(),
    };
    try {
      if (isNew) {
        const ref = await addDoc(collection(db, 'creditAccounts'), { ...data, balance: 0, createdAt: serverTimestamp() });
        await logAudit(profile, 'credit.accountCreate', { accountId: ref.id, name, limit });
      } else {
        await updateDoc(doc(db, 'creditAccounts', f.id), data);
        await logAudit(profile, 'credit.accountUpdate', { accountId: f.id, name, limit, previousLimit: Number(initial.limit), active: data.active });
      }
      toast('Saved.');
      onClose();
    } catch (e2) {
      setErr(e2.message);
    }
  };

  return (
    <Modal title={isNew ? 'Add credit account' : `Edit ${initial.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="aform">Save</button></>}>
      <form id="aform" onSubmit={save} className="grid-2">
        {err && <div className="alert alert-error span-2">{err}</div>}
        <Field label="Full name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
        <Field label="Student / employee ID"><input value={f.idNumber} onChange={(e) => setF({ ...f, idNumber: e.target.value })} required /></Field>
        <Field label="Type">
          <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Credit limit (₱)" hint={!isNew && Number(initial.balance) > 0 ? `Current balance ${peso(initial.balance)}` : undefined}>
          <input inputMode="decimal" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} />
        </Field>
        <Field label="Email" hint="For statements"><input type="email" value={f.email || ''} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        {f.type === 'student' && (
          <>
            <Field label="Parent / guardian"><input value={f.guardianName || ''} onChange={(e) => setF({ ...f, guardianName: e.target.value })} /></Field>
            <Field label="Guardian phone"><input value={f.guardianPhone || ''} onChange={(e) => setF({ ...f, guardianPhone: e.target.value })} /></Field>
            <Field label="Guardian email" hint="Statements go here for students"><input type="email" value={f.guardianEmail || ''} onChange={(e) => setF({ ...f, guardianEmail: e.target.value })} /></Field>
          </>
        )}
        <label className="check span-2"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Allowed to buy on credit</label>
      </form>
    </Modal>
  );
}

function AccountDetail({ account, manage, onEdit, onClose, onQr }) {
  const { profile } = useAuth();
  const toast = useToast();
  const purchases = useCollection(() => query(collection(db, 'sales'), where('creditAccountId', '==', account.id)), [account.id]);
  const payments = useCollection(() => query(collection(db, 'creditPayments'), where('accountId', '==', account.id)), [account.id]);
  const { shift } = useShift();
  const refunds = useCollection(() => query(collection(db, 'refunds'), where('creditAccountId', '==', account.id)), [account.id]);
  const [statement, setStatement] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);

  // Sorted in the browser so no composite Firestore index is needed.
  const history = [
    ...purchases.docs.map((s) => ({ id: s.id, when: s.createdAt, kind: 'Purchase', detail: s.receiptNo, amount: Number(s.total) })),
    ...payments.docs.map((p) => ({ id: p.id, when: p.createdAt, kind: 'Payment', detail: `${p.method}${p.reference ? ` · ${p.reference}` : ''} · ${p.byName}`, amount: -Number(p.amount) })),
    ...refunds.docs.filter((r) => Number(r.creditAmount) > 0).map((r) => ({ id: r.id, when: r.createdAt, kind: 'Payment', detail: `Refund ${r.refundNo} on ${r.receiptNo}`, amount: -Number(r.creditAmount) })),
  ].sort((a, b) => (toDate(b.when)?.getTime() || 0) - (toDate(a.when)?.getTime() || 0));

  const purchased = purchases.docs.reduce((t, s) => t + Number(s.total), 0);
  const paid = payments.docs.reduce((t, p) => t + Number(p.amount), 0) + refunds.docs.reduce((t, r) => t + (Number(r.creditAmount) || 0), 0);

  const pay = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await recordRepayment({ accountId: account.id, amount, method, reference, shiftId: shift?.id || '', profile });
      toast(`Payment recorded. New balance ${peso(r.after)}.`);
      setAmount('');
      setReference('');
    } catch (e2) {
      toast(e2.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal wide title={account.name} onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onQr}>ID QR card</button>
          <button className="btn" onClick={() => setStatement(true)}>Statement</button>
          {manage && <button className="btn" onClick={onEdit}>Edit account / limit</button>}
        </>
      }>
      {statement && <StatementModal account={account} sales={purchases.docs} refunds={refunds.docs} payments={payments.docs} onClose={() => setStatement(false)} />}
      <div className="stats">
        <Stat label="Balance owed" value={peso(account.balance)} kind={Number(account.balance) > 0 ? 'warn' : undefined} />
        <Stat label="Credit limit" value={peso(account.limit)} />
        <Stat label="Purchased / repaid or refunded" value={`${peso(purchased)} / ${peso(paid)}`} sub={Math.abs(round2(purchased - paid) - Number(account.balance)) > 0.009 ? 'Does not match balance — check restored or edited data' : 'Matches balance'} />
      </div>

      {Number(account.balance) > 0 && (
        <form className="box row-inline wrap" onSubmit={pay}>
          <strong>Record repayment</strong>
          <input inputMode="decimal" placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="cash">Cash</option>
            <option value="gcash">GCash</option>
          </select>
          {method === 'gcash' && <input placeholder="Reference no." value={reference} onChange={(e) => setReference(e.target.value)} />}
          <button type="button" className="btn btn-sm" onClick={() => setAmount(String(account.balance))}>Full balance</button>
          <button className="btn btn-primary" disabled={busy}>Save payment</button>
        </form>
      )}

      <ErrorNote error={purchases.error || payments.error} />
      <table>
        <thead><tr><th>Date</th><th>Type</th><th>Details</th><th className="num">Amount</th></tr></thead>
        <tbody>
          {history.map((h) => (
            <tr key={`${h.kind}-${h.id}`}>
              <td>{fmtDateTime(h.when)}</td>
              <td>{h.kind === 'Purchase' ? <Badge kind="warn">Purchase</Badge> : <Badge kind="ok">Payment</Badge>}</td>
              <td className="small">{h.detail}</td>
              <td className={`num ${h.amount < 0 ? 'pos' : ''}`}>{h.amount < 0 ? '−' : '+'}{peso(Math.abs(h.amount))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!history.length && <Empty>No credit activity yet.</Empty>}
    </Modal>
  );
}

import { useState } from 'react';
import { db, addDoc, collection, doc, serverTimestamp, updateDoc } from '../db';
import { useAuth } from '../context/AuthContext';
import { useCollection } from '../hooks/useCollection';
import { Badge, Empty, ErrorNote, Field, Modal, PageHead, useToast } from '../components/ui';
import { ROLES, ROLE_LABELS } from '../lib/roles';
import { fmtDate, fmtDateTime } from '../lib/format';
import { logAudit } from '../lib/audit';
import { pinFields, pinProblem, PIN_MAX, PIN_MIN } from '../lib/pin';

const ROLE_HELP = {
  admin: 'Everything, including staff, backup/restore and audit log',
  manager: 'Cashier, products, inventory, credit limits and reports',
  cashier: 'Cashier screen, sales history, credit purchases and repayments',
  inventory: 'Products, ingredients and stock',
  accountant: 'Accounting, reports and sales history (view only)',
};

const pinInput = (value, set, required) => (
  <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={PIN_MAX} value={value}
    onChange={(e) => set(e.target.value.replace(/\D/g, ''))} required={required} placeholder={required ? '' : 'Leave blank to keep current PIN'} />
);

export default function Users() {
  const { profile, staff, account } = useAuth();
  const toast = useToast();
  const [editing, setEditing] = useState(null);
  const [q, setQ] = useState('');
  const [showDisabled, setShowDisabled] = useState(false);

  const activeAdmins = staff.filter((s) => s.role === 'admin' && s.active !== false);
  const s = q.trim().toLowerCase();
  const rows = staff
    .filter((x) => showDisabled || x.active !== false)
    .filter((x) => !s || x.name.toLowerCase().includes(s))
    .sort((a, b) => a.name.localeCompare(b.name));

  const toggleActive = async (x) => {
    if (x.id === profile.id) return toast("You can't disable yourself.", 'error');
    if (x.active !== false && x.role === 'admin' && activeAdmins.length <= 1) return toast('Keep at least one active admin.', 'error');
    try {
      await updateDoc(doc(db, 'staff', x.id), { active: x.active === false, updatedAt: serverTimestamp() });
      await logAudit(profile, x.active === false ? 'staff.enable' : 'staff.disable', { staffId: x.id, name: x.name });
      toast(`${x.name} ${x.active === false ? 'enabled' : 'disabled'}.`);
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <PageHead title="Users & roles" sub="Staff who use the counter, and the sign-in accounts that unlock each device">
        <button className="btn btn-primary" onClick={() => setEditing({ name: '', role: 'cashier', active: true })}>Add staff</button>
      </PageHead>

      <div className="card role-help">
        {ROLES.map((r) => <div key={r}><strong>{ROLE_LABELS[r]}</strong><span className="muted small">{ROLE_HELP[r]}</span></div>)}
      </div>

      <h2>Staff</h2>
      <div className="filters">
        <input className="search" placeholder="Search staff" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check"><input type="checkbox" checked={showDisabled} onChange={(e) => setShowDisabled(e.target.checked)} /> Show disabled</label>
      </div>
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>PIN last changed</th><th>Status</th><th /></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.id}>
                <td><strong>{x.name}</strong>{x.id === profile.id && <span className="muted small"> (you)</span>}</td>
                <td>{ROLE_LABELS[x.role]}</td>
                <td className="small">{fmtDateTime(x.pinUpdatedAt || x.createdAt)}</td>
                <td>{x.active === false ? <Badge>Disabled</Badge> : <Badge kind="ok">Active</Badge>}</td>
                <td className="row-actions">
                  <button className="btn btn-sm" onClick={() => setEditing(x)}>Edit / reset PIN</button>
                  {x.id !== profile.id && (
                    <button className="btn btn-sm btn-ghost" onClick={() => toggleActive(x)}>{x.active === false ? 'Enable' : 'Disable'}</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <Empty>No staff match.</Empty>}
      </div>

      <Accounts isOwner={account?.role === 'admin'} myUid={account?.id} />

      {editing && <StaffForm initial={editing} staff={staff} activeAdmins={activeAdmins} onClose={() => setEditing(null)} />}
    </>
  );
}

function StaffForm({ initial, staff, activeAdmins, onClose }) {
  const { profile } = useAuth();
  const toast = useToast();
  const isNew = !initial.id;
  const [name, setName] = useState(initial.name);
  const [role, setRole] = useState(initial.role);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const isSelf = initial.id === profile.id;

  const save = async (e) => {
    e.preventDefault();
    setErr('');
    const n = name.trim();
    if (!n) return setErr('Name is required.');
    if (staff.some((x) => x.id !== initial.id && x.active !== false && x.name.toLowerCase() === n.toLowerCase())) {
      return setErr('Another active staff member has that name. Add a surname or initial so they can tell their tile apart.');
    }
    if (!isNew && initial.role === 'admin' && role !== 'admin' && activeAdmins.length <= 1) return setErr('Keep at least one active admin.');
    if (isSelf && role !== initial.role) return setErr("You can't change your own role.");
    if (isNew || pin) {
      const p = pinProblem(pin);
      if (p) return setErr(p);
      if (pin !== pin2) return setErr('The two PINs don’t match.');
    }
    setBusy(true);
    try {
      const pinData = pin ? { ...(await pinFields(pin)), pinUpdatedAt: serverTimestamp() } : {};
      if (isNew) {
        const ref = await addDoc(collection(db, 'staff'), { name: n, role, active: true, ...pinData, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        await logAudit(profile, 'staff.create', { staffId: ref.id, name: n, role });
      } else {
        await updateDoc(doc(db, 'staff', initial.id), { name: n, role, ...pinData, updatedAt: serverTimestamp() });
        if (role !== initial.role) await logAudit(profile, 'staff.roleChange', { staffId: initial.id, name: n, from: initial.role, to: role });
        if (n !== initial.name) await logAudit(profile, 'staff.rename', { staffId: initial.id, from: initial.name, to: n });
        if (pin) await logAudit(profile, 'staff.pinChange', { staffId: initial.id, name: n, by: isSelf ? 'self' : 'admin' });
      }
      toast(isNew ? `${n} added. They can now unlock the counter with their PIN.` : 'Saved.');
      onClose();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={isNew ? 'Add staff' : `Edit ${initial.name}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="staffform" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <form id="staffform" onSubmit={save} className="stack">
        {err && <div className="alert alert-error">{err}</div>}
        <Field label="Full name" hint="Shown on the counter lock screen and on receipts"><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value)} disabled={isSelf}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]} — {ROLE_HELP[r]}</option>)}
          </select>
        </Field>
        <div className="box">
          <strong>{isNew ? 'PIN' : 'Reset PIN'}</strong>
          <p className="muted small">{PIN_MIN}–{PIN_MAX} digits. Give it to the staff member privately; they can change it later under “Change my PIN”.</p>
          <Field label={isNew ? 'PIN' : 'New PIN'}>{pinInput(pin, setPin, isNew)}</Field>
          {(isNew || pin) && <Field label="Confirm PIN">{pinInput(pin2, setPin2, true)}</Field>}
        </div>
      </form>
    </Modal>
  );
}

/** Firebase sign-in accounts that may unlock a device. Only the owner account can approve them. */
function Accounts({ isOwner, myUid }) {
  const { profile } = useAuth();
  const toast = useToast();
  const users = useCollection(() => (isOwner ? collection(db, 'users') : null), [isOwner]);

  const set = async (u, patch) => {
    try {
      await updateDoc(doc(db, 'users', u.id), { ...patch, updatedAt: serverTimestamp() });
      await logAudit(profile, 'account.update', { uid: u.id, email: u.email, from: { role: u.role, active: u.active }, to: patch });
      toast('Account updated.');
    } catch (e) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <h2 className="mt">Sign-in accounts</h2>
      <p className="muted small">These are the email/Google logins that open the app on a device. Staff then unlock the counter with their own PIN. Approve an account when you set up another counter or tablet.</p>
      {!isOwner ? (
        <div className="alert alert-warn">Only the owner account (the first account created) can approve sign-in accounts. Sign in with it on this device to manage them.</div>
      ) : (
        <div className="card table-wrap">
          <ErrorNote error={users.error} />
          <table>
            <thead><tr><th>Email</th><th>Created</th><th>Status</th><th /></tr></thead>
            <tbody>
              {[...users.docs].sort((a, b) => (a.role === 'pending' ? -1 : 0) - (b.role === 'pending' ? -1 : 0)).map((u) => (
                <tr key={u.id} className={u.role === 'pending' ? 'row-warn' : ''}>
                  <td>{u.email}{u.id === myUid && <span className="muted small"> (this device)</span>}</td>
                  <td>{fmtDate(u.createdAt)}</td>
                  <td>
                    {u.role === 'admin' ? <Badge kind="info">Owner</Badge> : u.role === 'pending' ? <Badge kind="warn">Waiting</Badge> : u.active === false ? <Badge>Disabled</Badge> : <Badge kind="ok">Approved</Badge>}
                  </td>
                  <td className="row-actions">
                    {u.id !== myUid && u.role === 'pending' && <button className="btn btn-sm btn-primary" onClick={() => set(u, { role: 'device', active: true })}>Approve</button>}
                    {u.id !== myUid && u.role === 'device' && (
                      <button className="btn btn-sm btn-ghost" onClick={() => set(u, { active: u.active === false })}>{u.active === false ? 'Enable' : 'Disable'}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!users.loading && !users.docs.length && <Empty>No accounts.</Empty>}
        </div>
      )}
    </>
  );
}

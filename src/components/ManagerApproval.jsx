import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Field } from './ui';
import { verifyPin, PIN_MAX } from '../lib/pin';

/**
 * Lets a manager or admin approve an action with their PIN.
 * onApproved({ id, name, role }) is called once the PIN checks out.
 */
export default function ManagerApproval({ onApproved, label = 'Approve' }) {
  const { staff, profile } = useAuth();
  const managers = staff.filter((s) => s.active !== false && ['admin', 'manager'].includes(s.role));
  const [id, setId] = useState(managers.find((m) => m.id === profile?.id)?.id || managers[0]?.id || '');
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const check = async () => {
    const m = managers.find((x) => x.id === id);
    if (!m) return setErr('Choose who is approving.');
    setBusy(true);
    setErr('');
    const ok = await verifyPin(pin, m);
    setBusy(false);
    if (!ok) {
      setPin('');
      return setErr('Wrong PIN.');
    }
    onApproved({ id: m.id, name: m.name, role: m.role });
  };

  if (!managers.length) return <div className="alert alert-warn">No manager or admin staff exist to approve this.</div>;

  return (
    <div className="box approval">
      <strong>Manager approval</strong>
      {err && <div className="alert alert-error">{err}</div>}
      <div className="row-inline wrap">
        <Field label="Approved by">
          <select value={id} onChange={(e) => setId(e.target.value)}>
            {managers.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
          </select>
        </Field>
        <Field label="Their PIN">
          <input type="password" inputMode="numeric" autoComplete="off" maxLength={PIN_MAX} value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => e.key === 'Enter' && check()} />
        </Field>
        <button type="button" className="btn btn-primary" disabled={busy || pin.length < 4} onClick={check}>{busy ? 'Checking…' : label}</button>
      </div>
    </div>
  );
}

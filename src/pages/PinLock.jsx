import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import PinPad from '../components/PinPad';
import { APP } from '../config/app';
import { ROLE_LABELS } from '../lib/roles';
import { PIN_MIN } from '../lib/pin';

const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

export default function PinLock() {
  const { staff, unlock, account, logout } = useAuth();
  const [picked, setPicked] = useState(null);
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const people = staff.filter((s) => s.active !== false).sort((a, b) => a.name.localeCompare(b.name));
  const person = people.find((p) => p.id === picked);

  const submit = async () => {
    if (!person || pin.length < PIN_MIN || busy) return;
    setBusy(true);
    setErr('');
    try {
      await unlock(person.id, pin);
    } catch (e) {
      setErr(e.message);
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="lock-card">
        <div className="brand brand-lg">
          <span className="brand-mark">CC</span>
          <span className="brand-name">{APP.canteenName}</span>
        </div>

        {!person ? (
          <>
            <h1>Who's working?</h1>
            <p className="muted">Tap your name, then enter your PIN.</p>
            <div className="staff-grid">
              {people.map((p) => (
                <button key={p.id} className="staff-tile" onClick={() => { setPicked(p.id); setPin(''); setErr(''); }}>
                  <span className="avatar">{initials(p.name)}</span>
                  <span className="staff-name">{p.name}</span>
                  <span className="muted small">{ROLE_LABELS[p.role]}</span>
                </button>
              ))}
            </div>
            {!people.length && <p className="muted">No staff profiles yet. Ask the admin to add you under Users &amp; roles.</p>}
          </>
        ) : (
          <>
            <button className="link" onClick={() => { setPicked(null); setPin(''); setErr(''); }}>← Not {person.name.split(' ')[0]}?</button>
            <div className="lock-who">
              <span className="avatar avatar-lg">{initials(person.name)}</span>
              <div>
                <h1>{person.name}</h1>
                <span className="muted">{ROLE_LABELS[person.role]}</span>
              </div>
            </div>
            {err && <div className="alert alert-error">{err}</div>}
            <PinPad value={pin} onChange={(v) => { setPin(v); setErr(''); }} onSubmit={submit} disabled={busy} />
            <button className="btn btn-primary btn-block btn-lg" disabled={pin.length < PIN_MIN || busy} onClick={submit}>
              {busy ? 'Checking…' : 'Unlock'}
            </button>
          </>
        )}

        <div className="lock-foot muted small">
          <span>Device signed in as {account?.email}</span>
          <button className="link" onClick={logout}>Sign out of device</button>
        </div>
      </div>
    </div>
  );
}

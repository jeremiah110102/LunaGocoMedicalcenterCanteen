import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { APP } from '../config/app';
import { pinProblem, PIN_MAX, PIN_MIN } from '../lib/pin';

/** Shown once: the owner account creates the first admin staff profile and its PIN. */
export default function SetupAdmin() {
  const { user, account, createFirstAdmin, logout } = useAuth();
  const [name, setName] = useState(user?.displayName || '');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const isOwner = account?.role === 'admin';

  const submit = async (e) => {
    e.preventDefault();
    setErr('');
    if (!name.trim()) return setErr('Enter your name.');
    const p = pinProblem(pin);
    if (p) return setErr(p);
    if (pin !== pin2) return setErr('The two PINs don’t match.');
    setBusy(true);
    try {
      await createFirstAdmin(name, pin);
    } catch (e2) {
      setErr(e2.message);
      setBusy(false);
    }
  };

  if (!isOwner) {
    return (
      <div className="center-screen">
        <div className="card narrow">
          <h1>Not set up yet</h1>
          <p>This canteen has no admin staff profile yet. The owner account must sign in once to finish setup.</p>
          <button className="btn" onClick={logout}>Sign out</button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="brand brand-lg">
          <span className="brand-mark">CC</span>
          <span className="brand-name">{APP.canteenName}</span>
        </div>
        <h1>Welcome — you're the admin</h1>
        <p className="muted">This is the first account, so it's the owner. Create your admin staff profile. Your PIN is what you'll use to unlock the counter.</p>
        {err && <div className="alert alert-error">{err}</div>}
        <div className="stack">
          <label className="field"><span className="field-label">Your name (shown on receipts)</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="field"><span className="field-label">PIN ({PIN_MIN}–{PIN_MAX} digits)</span>
            <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={PIN_MAX} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} required />
          </label>
          <label className="field"><span className="field-label">Confirm PIN</span>
            <input type="password" inputMode="numeric" autoComplete="new-password" maxLength={PIN_MAX} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ''))} required />
          </label>
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Saving…' : 'Create admin profile'}</button>
        </div>
      </form>
    </div>
  );
}

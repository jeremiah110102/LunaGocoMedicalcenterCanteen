import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { APP } from '../config/app';

const MESSAGES = {
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/user-not-found': 'No account with that email.',
  'auth/wrong-password': 'Wrong email or password.',
  'auth/email-already-in-use': 'That email already has an account. Sign in instead.',
  'auth/weak-password': 'Password must be at least 6 characters.',
  'auth/invalid-email': 'Enter a valid email address.',
  'auth/popup-closed-by-user': 'Google sign-in was closed before finishing.',
  'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
  'auth/operation-not-allowed': 'This sign-in method is not enabled in Firebase Authentication.',
  'auth/unauthorized-domain': 'This domain is not authorised in Firebase Authentication settings.',
};

export default function Login() {
  const { loginEmail, loginGoogle, register, resetPassword } = useAuth();
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const run = async (fn) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ kind: 'error', text: MESSAGES[e.code] || e.message });
    } finally {
      setBusy(false);
    }
  };

  const submit = (e) => {
    e.preventDefault();
    run(() => (mode === 'login' ? loginEmail(email, password) : register(name, email, password)));
  };

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="brand brand-lg">
          <span className="brand-mark">CC</span>
          <span className="brand-name">{APP.canteenName}</span>
        </div>
        <h1>{mode === 'login' ? 'Sign in' : 'Create staff account'}</h1>
        <p className="muted">{mode === 'login' ? 'Point of sale and inventory for the canteen team.' : 'The very first account becomes the admin. Later accounts need the admin’s approval.'}</p>

        {msg && <div className={`alert alert-${msg.kind}`}>{msg.text}</div>}

        <form onSubmit={submit} className="stack">
          {mode === 'register' && (
            <label className="field"><span className="field-label">Full name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
            </label>
          )}
          <label className="field"><span className="field-label">Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </label>
          <label className="field"><span className="field-label">Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </label>
          <button className="btn btn-primary btn-block" disabled={busy}>{mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>

        <div className="divider"><span>or</span></div>
        <button className="btn btn-block" onClick={() => run(loginGoogle)} disabled={busy}>
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
          Continue with Google
        </button>

        <div className="login-links">
          {mode === 'login' ? (
            <>
              <button className="link" onClick={() => setMode('register')}>Create an account</button>
              <button
                className="link"
                onClick={() =>
                  email
                    ? run(async () => { await resetPassword(email); setMsg({ kind: 'ok', text: 'Password reset email sent.' }); })
                    : setMsg({ kind: 'error', text: 'Type your email first, then click "Forgot password".' })
                }
              >
                Forgot password
              </button>
            </>
          ) : (
            <button className="link" onClick={() => setMode('login')}>I already have an account</button>
          )}
        </div>
      </div>
    </div>
  );
}

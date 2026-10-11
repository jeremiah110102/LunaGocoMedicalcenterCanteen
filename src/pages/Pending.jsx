import { useAuth } from '../context/AuthContext';

export default function Pending() {
  const { user, account, logout } = useAuth();
  const disabled = account?.active === false;
  return (
    <div className="center-screen">
      <div className="card narrow">
        <h1>{disabled ? 'Account disabled' : 'Waiting for approval'}</h1>
        <p>
          {disabled
            ? 'This account has been disabled by an administrator.'
            : 'This sign-in account was created. The canteen admin needs to approve it (Users & roles → Sign-in accounts) before this device can be used.'}
        </p>
        <p className="muted">Signed in as {user?.email}. This page updates automatically once the account is approved.</p>
        <button className="btn" onClick={logout}>Log out</button>
      </div>
    </div>
  );
}

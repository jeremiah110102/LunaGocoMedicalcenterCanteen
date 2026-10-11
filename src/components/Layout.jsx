import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { can, ROLE_LABELS } from '../lib/roles';
import { APP } from '../config/app';
import { useEffect, useState } from 'react';
import ChangePin from './ChangePin';
import { useToast } from './ui';
import { useOfflineQueue } from './Scanning';
import { startOfflineSync } from '../services/offline';
import { runDailyJobs } from '../services/sheetsCopy';

let dailyRan = false; // once per app session

const NAV = [
  { to: '/', area: 'dashboard', label: 'Dashboard', icon: '◫' },
  { to: '/pos', area: 'pos', label: 'Cashier (POS)', icon: '₱' },
  { to: '/sales', area: 'sales', label: 'Sales history', icon: '≡' },
  { to: '/shifts', area: 'shifts', label: 'Shifts & cash', icon: '◴' },
  { to: '/products', area: 'products', label: 'Products', icon: '▦' },
  { to: '/ingredients', area: 'ingredients', label: 'Ingredients', icon: '❖' },
  { to: '/inventory', area: 'inventory', label: 'Inventory', icon: '⇅' },
  { to: '/purchasing', area: 'purchasing', label: 'Purchase orders', icon: '⊞' },
  { to: '/credit', area: 'credit', label: 'Credit accounts', icon: '◷' },
  { to: '/expenses', area: 'expenses', label: 'Expenses', icon: '−' },
  { to: '/reports', area: 'reports', label: 'Reports', icon: '▤' },
  { to: '/accounting', area: 'accounting', label: 'Accounting', icon: '∑' },
  { to: '/users', area: 'users', label: 'Users & roles', icon: '◉' },
  { to: '/backup', area: 'backup', label: 'Backup & restore', icon: '⤓' },
  { to: '/audit', area: 'audit', label: 'Audit log', icon: '⌕' },
  { to: '/settings', area: 'settings', label: 'Settings', icon: '⚙' },
];

export default function Layout() {
  const { profile, lock, logout, account } = useAuth();
  const [open, setOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const toast = useToast();
  const { online, queue } = useOfflineQueue();

  // Send offline sales in the background whenever the connection is back.
  useEffect(() => startOfflineSync((r) => toast(`${r.sent} offline sale(s) sent.${r.left ? ` ${r.left} still waiting.` : ''}`)), [toast]);
  // Daily backup / Google Sheets copy, when an admin opens the app.
  useEffect(() => {
    if (profile?.role === 'admin' && !dailyRan && navigator.onLine) {
      dailyRan = true;
      runDailyJobs(profile, (m, kind) => toast(m, kind));
    }
  }, [profile, toast]);
  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'is-open' : ''}`}>
        <div className="brand">
          <span className="brand-mark">CC</span>
          <span className="brand-name">{APP.canteenName}</span>
        </div>
        <nav onClick={() => setOpen(false)}>
          {NAV.filter((n) => can(profile, n.area)).map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className="nav-link">
              <span className="nav-icon" aria-hidden>{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        {(!online || queue.length > 0) && (
          <div className={`net-status ${online ? 'is-sync' : 'is-off'}`}>
            {online ? `Sending ${queue.length} offline sale(s)…` : `Offline${queue.length ? ` · ${queue.length} sale(s) waiting` : ''}`}
          </div>
        )}
        <div className="me">
          <div className="me-name">{profile.displayName || profile.email}</div>
          <div className="me-role">{ROLE_LABELS[profile.role]}</div>
          <button className="btn btn-sm me-lock" onClick={lock}>Lock / switch user</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setPinOpen(true)}>Change my PIN</button>
          <button className="btn btn-ghost btn-sm" title={account?.email} onClick={logout}>Sign out of device</button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setOpen((o) => !o)} aria-label="Menu">☰</button>
          <span className="brand-name">{APP.canteenName}</span>
          {!online && <span className="badge badge-bad">Offline</span>}
          <span className="topbar-who">{profile.displayName}</span>
          <button className="btn btn-sm" onClick={lock}>Lock</button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
      {pinOpen && <ChangePin onClose={() => setPinOpen(false)} />}
    </div>
  );
}

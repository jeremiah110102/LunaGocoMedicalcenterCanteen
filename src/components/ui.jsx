import { createContext, useCallback, useContext, useEffect, useState } from 'react';

/* ---------- Toasts ---------- */
const ToastContext = createContext(() => {});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, kind = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.message}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export const useToast = () => useContext(ToastContext);

/* ---------- Modal ---------- */
export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/* ---------- Small pieces ---------- */
export const Field = ({ label, hint, children }) => (
  <label className="field">
    <span className="field-label">{label}</span>
    {children}
    {hint && <span className="field-hint">{hint}</span>}
  </label>
);

export const Empty = ({ children }) => <div className="empty">{children}</div>;

export const Badge = ({ kind = 'neutral', children }) => <span className={`badge badge-${kind}`}>{children}</span>;

export const Stat = ({ label, value, sub, kind }) => (
  <div className={`stat ${kind ? `stat-${kind}` : ''}`}>
    <div className="stat-label">{label}</div>
    <div className="stat-value">{value}</div>
    {sub && <div className="stat-sub">{sub}</div>}
  </div>
);

export const PageHead = ({ title, sub, children }) => (
  <div className="page-head">
    <div>
      <h1>{title}</h1>
      {sub && <p className="muted">{sub}</p>}
    </div>
    <div className="page-actions">{children}</div>
  </div>
);

export function ErrorNote({ error }) {
  if (!error) return null;
  const msg = error.code === 'permission-denied'
    ? 'You do not have permission to see this data, or the Firestore rules have not been deployed.'
    : error.message || String(error);
  return <div className="alert alert-error">{msg}</div>;
}

/** Simple horizontal bar list: rows = [{ label, value, display }] */
export function BarList({ rows, emptyText = 'No data.' }) {
  if (!rows.length) return <Empty>{emptyText}</Empty>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="barlist">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="barlist-row">
            <span className="barlist-label">{r.label}</span>
            <span className="barlist-value">{r.display ?? r.value}</span>
          </div>
          <div className="barlist-track"><div className="barlist-fill" style={{ width: `${(r.value / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

/** Vertical columns for a time series: rows = [{ label, value, display }] */
export function Columns({ rows }) {
  if (!rows.length) return <Empty>No sales in this period.</Empty>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="columns" role="img" aria-label="Sales by day">
      {rows.map((r) => (
        <div className="col" key={r.label} title={`${r.label}: ${r.display}`}>
          <div className="col-bar" style={{ height: `${Math.max((r.value / max) * 100, r.value ? 2 : 0)}%` }} />
          <div className="col-label">{r.label.slice(5)}</div>
        </div>
      ))}
    </div>
  );
}

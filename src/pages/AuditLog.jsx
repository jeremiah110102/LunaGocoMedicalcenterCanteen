import { useState } from 'react';
import { db, collection, limit, orderBy, query } from '../db';
import { useCollection } from '../hooks/useCollection';
import { Empty, ErrorNote, PageHead } from '../components/ui';
import { fmtDateTime } from '../lib/format';

export default function AuditLog() {
  const [max, setMax] = useState(200);
  const [q, setQ] = useState('');
  const logs = useCollection(() => query(collection(db, 'auditLogs'), orderBy('createdAt', 'desc'), limit(max)), [max]);
  const s = q.trim().toLowerCase();
  const rows = logs.docs.filter((l) => !s || l.action.toLowerCase().includes(s) || (l.actorName || '').toLowerCase().includes(s) || JSON.stringify(l.details || {}).toLowerCase().includes(s));

  return (
    <>
      <PageHead title="Audit log" sub="Sensitive actions: price changes, stock changes, credit, users, backup and restore" />
      <div className="filters"><input className="search" placeholder="Filter by action, person or detail" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <ErrorNote error={logs.error} />
      <div className="card table-wrap">
        <table>
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <td>{fmtDateTime(l.createdAt)}</td>
                <td>{l.actorName}<div className="muted small">{l.actorRole}</div></td>
                <td className="mono">{l.action}</td>
                <td className="small details">{Object.entries(l.details || {}).map(([k, v]) => <div key={k}><span className="muted">{k}:</span> {typeof v === 'object' ? JSON.stringify(v) : String(v)}</div>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!logs.loading && !rows.length && <Empty>No entries.</Empty>}
      </div>
      {logs.docs.length >= max && <button className="btn" onClick={() => setMax(max + 200)}>Load more</button>}
    </>
  );
}

import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { PageHead, useToast } from '../components/ui';
import { exportBackup, previewRestore, readBackupFile, restoreBackup } from '../services/backup';
import { fmtDateTime } from '../lib/format';

export default function Backup() {
  const { profile, account } = useAuth();
  const isOwner = account?.role === 'admin';
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [parsed, setParsed] = useState(null);
  const [preview, setPreview] = useState(null);
  const [safetyDone, setSafetyDone] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [progress, setProgress] = useState(null);
  const [fileName, setFileName] = useState('');

  const doExport = async (label) => {
    setBusy('export');
    try {
      const counts = await exportBackup(profile, { label });
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      toast(`Backup downloaded (${total} records).`);
      if (label === 'before-restore') setSafetyDone(true);
    } catch (e) {
      toast(`Backup failed: ${e.message}`, 'error');
    } finally {
      setBusy('');
    }
  };

  const pick = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileName(file.name);
    setParsed(null);
    setPreview(null);
    setSafetyDone(false);
    setConfirmText('');
    setProgress(null);
    setBusy('read');
    try {
      const p = await readBackupFile(file);
      setParsed(p);
      if (p.ok) setPreview(await previewRestore(p));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const doRestore = async () => {
    setBusy('restore');
    try {
      const n = await restoreBackup(parsed, profile, { onProgress: (done, total) => setProgress({ done, total }) });
      toast(`Restore complete: ${n} records written.`);
      setParsed(null);
      setPreview(null);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <PageHead title="Backup & restore" sub="Excel (.xlsx) copies of all canteen data" />

      <section className="card">
        <h2>Back up</h2>
        <p className="muted">Downloads one workbook with a sheet per collection: users, categories, products, ingredients, credit accounts, sales, credit payments, stock movements and audit log. Keep copies somewhere safe, such as a school drive.</p>
        <button className="btn btn-primary" disabled={!!busy} onClick={() => doExport('backup')}>{busy === 'export' ? 'Preparing…' : 'Download backup'}</button>
      </section>

      <section className="card">
        <h2>Restore</h2>
        <p className="muted">Writes the records in a backup file back into the database with their original IDs. Records in the file replace current records with the same ID; records not in the file are kept.</p>
        {!isOwner && <div className="alert alert-warn">Restoring needs the owner sign-in account (the first account created). Sign this device in with it to restore.</div>}

        <ol className="steps">
          <li className={parsed ? 'done' : ''}>
            <strong>Choose a backup file</strong>
            <label className="btn file-btn">
              {busy === 'read' ? 'Checking…' : 'Choose .xlsx file'}
              <input type="file" accept=".xlsx" onChange={pick} disabled={!!busy || !isOwner} hidden />
            </label>
            {fileName && <span className="muted small">{fileName}</span>}
          </li>

          {parsed && (
            <li className={parsed.ok ? 'done' : 'bad'}>
              <strong>Check the file</strong>
              {parsed.errors.length > 0 && (
                <div className="alert alert-error">
                  <p>This file can't be restored:</p>
                  <ul>{parsed.errors.slice(0, 20).map((e) => <li key={e}>{e}</li>)}</ul>
                  {parsed.errors.length > 20 && <p>…and {parsed.errors.length - 20} more.</p>}
                </div>
              )}
              {parsed.warnings.map((w) => <div key={w} className="alert alert-warn">{w}</div>)}
              {parsed.ok && parsed.meta?.exportedAt && <p className="muted small">Backup made {fmtDateTime(parsed.meta.exportedAt)} by {parsed.meta.exportedBy}.</p>}
              {preview && (
                <table>
                  <thead><tr><th>Sheet</th><th className="num">In file</th><th className="num">Currently</th><th className="num">Will replace</th><th className="num">Will add</th></tr></thead>
                  <tbody>
                    {preview.map((p) => (
                      <tr key={p.name}><td>{p.name}</td><td className="num">{p.inFile}</td><td className="num">{p.current}</td><td className="num">{p.overwrite}</td><td className="num">{p.create}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          )}

          {parsed?.ok && (
            <li className={safetyDone ? 'done' : ''}>
              <strong>Save a backup of the current data first</strong>
              <button className="btn" disabled={!!busy} onClick={() => doExport('before-restore')}>{safetyDone ? 'Saved ✓ — download again' : 'Download safety backup'}</button>
            </li>
          )}

          {parsed?.ok && safetyDone && (
            <li>
              <strong>Confirm</strong>
              <p className="muted small">Type <code>RESTORE</code> to continue. The restore is recorded in the audit log.</p>
              <div className="row-inline">
                <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="RESTORE" />
                <button className="btn btn-danger" disabled={confirmText !== 'RESTORE' || !!busy} onClick={doRestore}>
                  {busy === 'restore' ? 'Restoring…' : 'Restore now'}
                </button>
              </div>
              {progress && <progress max={progress.total} value={progress.done} />}
            </li>
          )}
        </ol>
      </section>
    </>
  );
}

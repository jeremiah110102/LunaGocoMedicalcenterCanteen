import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Badge, Field, PageHead } from '../components/ui';
import { BACKENDS, backend, connection } from '../db';
import { firebaseConfig } from '../firebase/config';
import { sameDatabase, switchDatabase, testDatabase } from '../db/switch';
import { exportBackup, readBackupFile } from '../services/backup';
import { fmtDateTime } from '../lib/format';
import { BackupSettings, PrinterSettings, SheetsCopySettings } from './SettingsExtras';

const HELP = {
  firestore: (
    <ol className="help-steps">
      <li>Uses the Firestore database of your Firebase project (<code>{firebaseConfig.projectId}</code>).</li>
      <li>Deploy <code>firestore.rules</code> from the project: <code>firebase deploy --only firestore:rules</code>.</li>
    </ol>
  ),
  supabase: (
    <ol className="help-steps">
      <li>Create a project at <a href="https://supabase.com" target="_blank" rel="noreferrer">supabase.com</a> (free plan is fine).</li>
      <li>SQL Editor → New query → paste <code>supabase/schema.sql</code> from this project → Run.</li>
      <li>Authentication → Third-party Auth → Add provider → <b>Firebase</b> → Project ID <code>{firebaseConfig.projectId}</code>.</li>
      <li>Project Settings → API Keys: copy the <b>Project URL</b> and the <b>publishable</b> (or anon public) key. Never the secret key.</li>
    </ol>
  ),
  sheets: (
    <ol className="help-steps">
      <li>Create a Google Sheet → Extensions → Apps Script → paste <code>google-apps-script/Database.gs</code>.</li>
      <li>Set <code>FIREBASE_API_KEY</code> at the top to <code>{firebaseConfig.apiKey}</code> (your Firebase Web API key). Save.</li>
      <li>Run <b>authorize</b> once, then Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.</li>
      <li>Copy the Web app URL (ends with <code>/exec</code>).</li>
    </ol>
  ),
};

export default function Settings() {
  const { account, profile } = useAuth();
  const isOwner = account?.role === 'admin';
  const [choice, setChoice] = useState({
    backend: backend === 'firestore' ? 'supabase' : 'firestore',
    supabaseUrl: connection.supabaseUrl || '',
    supabaseKey: connection.supabaseKey || '',
    sheetsUrl: connection.sheetsUrl || '',
  });
  const [test, setTest] = useState(null);
  const [source, setSource] = useState('current');
  const [parsed, setParsed] = useState(null);
  const [busy, setBusy] = useState('');
  const [steps, setSteps] = useState([]);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [backedUp, setBackedUp] = useState(false);

  const set = (k) => (e) => {
    setChoice({ ...choice, [k]: e.target.value });
    setTest(null);
  };
  const same = sameDatabase(choice, connection);

  const runTest = async () => {
    setBusy('test');
    setTest(null);
    setTest(await testDatabase(choice));
    setBusy('');
  };

  const pickFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setBusy('file');
    setParsed(await readBackupFile(f));
    setBusy('');
  };

  const doSwitch = async () => {
    if (!window.confirm(`Move the canteen to ${BACKENDS[choice.backend]}? Every device will use it after reloading.`)) return;
    setBusy('switch');
    setError('');
    setSteps([]);
    try {
      await switchDatabase({
        choice,
        source,
        parsed,
        account,
        profile,
        onStep: (s) => setSteps((x) => [...x, s]),
        onProgress: (done, total) => setProgress({ done, total }),
      });
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      setError(e.message || String(e));
      setBusy('');
    }
  };

  const canSwitch = isOwner && test?.ok && !same && !busy && (source !== 'file' || parsed?.ok);

  return (
    <>
      <PageHead title="Settings" sub="Printer, backups, Google Sheets copy, and where the data is stored" />
      <PrinterSettings />
      <BackupSettings />
      <SheetsCopySettings />

      <section className="card">
        <h2>Current database</h2>
        <div className="row-inline wrap">
          <Badge kind="info">{BACKENDS[backend]}</Badge>
          <span className="muted small">
            {backend === 'supabase' ? connection.supabaseUrl : backend === 'sheets' ? 'Google Sheet (Apps Script)' : `Firebase project ${firebaseConfig.projectId}`}
          </span>
        </div>
        {connection.updatedBy && <p className="muted small mt-sm">Changed by {connection.updatedBy}{connection.updatedAt ? ` on ${fmtDateTime(connection.updatedAt)}` : ''}.</p>}
        <p className="muted small mt-sm">Sign-in always uses Firebase Authentication. Product photos can be uploaded only when the database is Supabase.</p>
      </section>

      <section className="card">
        <h2>Change database</h2>
        {!isOwner && <div className="alert alert-warn">Only the owner account (the first account created) can change the database. Sign this device in with it.</div>}

        <div className="seg db-seg">
          {Object.entries(BACKENDS).map(([k, label]) => (
            <button key={k} type="button" className={choice.backend === k ? 'is-on' : ''} onClick={() => { setChoice({ ...choice, backend: k }); setTest(null); }}>
              {label}
            </button>
          ))}
        </div>

        <div className="grid-2">
          <div className="stack">
            {choice.backend === 'supabase' && (
              <>
                <Field label="Project URL"><input placeholder="https://abcdefgh.supabase.co" value={choice.supabaseUrl} onChange={set('supabaseUrl')} /></Field>
                <Field label="Publishable key" hint="sb_publishable_… or the anon public key"><input value={choice.supabaseKey} onChange={set('supabaseKey')} /></Field>
              </>
            )}
            {choice.backend === 'sheets' && (
              <Field label="Apps Script Web app URL"><input placeholder="https://script.google.com/macros/s/…/exec" value={choice.sheetsUrl} onChange={set('sheetsUrl')} /></Field>
            )}
            {choice.backend === 'sheets' && (
              <div className="alert alert-warn">Google Sheets is slower than the other two (each save takes a second or two, and other counters see changes within about 20 seconds). Good for a small canteen; use Supabase or Firebase for busy counters.</div>
            )}
            <div className="row-inline">
              <button className="btn" onClick={runTest} disabled={!!busy || same}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
              {same && <span className="muted small">This is the database in use now.</span>}
            </div>
            {test && <div className={`alert alert-${test.level === 'ok' ? 'ok' : test.level === 'warning' ? 'warn' : 'error'}`}>{test.message}</div>}
          </div>
          <div className="box">
            <strong>Setup for {BACKENDS[choice.backend]}</strong>
            {HELP[choice.backend]}
          </div>
        </div>

        <h3 className="mt">Data to bring along</h3>
        <div className="stack-sm">
          <label className="check"><input type="radio" name="src" checked={source === 'current'} onChange={() => setSource('current')} /> Copy everything from the current database ({BACKENDS[backend]})</label>
          <label className="check"><input type="radio" name="src" checked={source === 'file'} onChange={() => setSource('file')} /> Load an Excel backup file (.xlsx from Backup &amp; restore)</label>
          {source === 'file' && (
            <div className="box">
              <label className="btn file-btn">
                {busy === 'file' ? 'Checking…' : 'Choose backup file'}
                <input type="file" accept=".xlsx" hidden onChange={pickFile} disabled={!!busy} />
              </label>
              {parsed && !parsed.ok && <div className="alert alert-error">{parsed.errors.slice(0, 8).join('\n')}</div>}
              {parsed?.ok && <span className="muted small">Backup OK: {Object.entries(parsed.counts).map(([k, v]) => `${v} ${k}`).join(', ')}</span>}
            </div>
          )}
          <label className="check"><input type="radio" name="src" checked={source === 'empty'} onChange={() => setSource('empty')} /> Start empty (you'll set up your admin PIN again)</label>
        </div>

        <div className="box mt">
          <strong>Before switching</strong>
          <p className="muted small">Download a backup of the current data, just in case.</p>
          <button className="btn btn-sm" disabled={!!busy} onClick={async () => { await exportBackup(profile, { label: 'before-switch' }); setBackedUp(true); }}>
            {backedUp ? 'Backup downloaded ✓' : 'Download backup'}
          </button>
        </div>

        {error && <div className="alert alert-error mt">{error}</div>}
        {steps.length > 0 && (
          <ul className="plain-list mt">
            {steps.map((s, i) => <li key={i} className="small">{s}</li>)}
          </ul>
        )}
        {progress && <progress max={progress.total} value={progress.done} />}

        <div className="row-inline mt">
          <button className="btn btn-primary" disabled={!canSwitch} onClick={doSwitch}>
            {busy === 'switch' ? 'Switching…' : `Switch to ${BACKENDS[choice.backend]}`}
          </button>
          {!test?.ok && !same && <span className="muted small">Test the connection first.</span>}
        </div>
      </section>
    </>
  );
}

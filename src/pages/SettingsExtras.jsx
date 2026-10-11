import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Field, useToast } from '../components/ui';
import { getDeviceSettings, saveDeviceSettings } from '../lib/deviceSettings';
import { fmtDateTime } from '../lib/format';
import { exportBackup } from '../services/backup';
import { loadSetting, saveBackupSettings, saveSheetsCopySettings, syncToSheets, testSheetsCopy } from '../services/sheetsCopy';

export function PrinterSettings() {
  const toast = useToast();
  const [s, setS] = useState(getDeviceSettings());
  const set = (patch) => {
    const next = { ...s, ...patch };
    setS(next);
    saveDeviceSettings(next);
    toast('Saved for this device.');
  };
  return (
    <section className="card">
      <h2>Receipt printer &amp; scanner (this device)</h2>
      <div className="grid-2">
        <Field label="Paper width">
          <select value={s.paperWidth} onChange={(e) => set({ paperWidth: Number(e.target.value) })}>
            <option value={58}>58 mm thermal</option>
            <option value={80}>80 mm thermal</option>
          </select>
        </Field>
        <div className="stack-sm">
          <label className="check"><input type="checkbox" checked={s.autoPrint} onChange={(e) => set({ autoPrint: e.target.checked })} /> Print automatically after each sale</label>
          <label className="check"><input type="checkbox" checked={s.kitchenSlip} onChange={(e) => set({ kitchenSlip: e.target.checked })} /> Also print a kitchen order slip</label>
          <label className="check"><input type="checkbox" checked={s.largeText} onChange={(e) => set({ largeText: e.target.checked })} /> Larger text on receipts</label>
          <label className="check"><input type="checkbox" checked={s.scanSound} onChange={(e) => set({ scanSound: e.target.checked })} /> Beep when a scanned item is added</label>
        </div>
      </div>
      <p className="muted small mt">
        Set the thermal printer as the default printer with no margins. To print without the print dialog, start Chrome with
        {' '}<code>--kiosk-printing</code> (add it to the Chrome shortcut on the counter computer).
      </p>
      <p className="muted small">
        Scanners: USB and Bluetooth barcode/QR readers work on the cashier screen with no setup (they act like a keyboard).
        Phone/tablet cameras: tap <b>Scan</b> on the cashier screen; the camera needs the app’s https:// address.
      </p>
    </section>
  );
}

export function BackupSettings() {
  const { profile } = useAuth();
  const toast = useToast();
  const [b, setB] = useState(null);
  useEffect(() => {
    loadSetting('backup').then(setB).catch(() => setB({}));
  }, []);
  if (!b) return null;
  const toggle = async (autoDaily) => {
    try {
      await saveBackupSettings({ autoDaily });
      setB({ ...b, autoDaily });
      toast(autoDaily ? 'Daily backup switched on.' : 'Daily backup switched off.');
    } catch (e) {
      toast(e.message, 'error');
    }
  };
  return (
    <section className="card">
      <h2>Automatic daily backup</h2>
      <label className="check"><input type="checkbox" checked={!!b.autoDaily} onChange={(e) => toggle(e.target.checked)} /> Download a backup automatically the first time an admin opens the app each day</label>
      <p className="muted small mt">
        Browsers can’t run anything while closed, so the backup happens when an admin unlocks. Save the files to a school drive or USB.
        {b.lastBackupAt && <> Last daily backup: {fmtDateTime(b.lastBackupAt)} by {b.lastBackupBy}.</>}
      </p>
      <button className="btn btn-sm" onClick={async () => {
        await exportBackup(profile, { label: 'manual' });
        await saveBackupSettings({ lastBackupAt: new Date(), lastBackupBy: profile.displayName });
        setB({ ...b, lastBackupAt: new Date(), lastBackupBy: profile.displayName });
      }}>Back up now</button>
    </section>
  );
}

export function SheetsCopySettings() {
  const { profile } = useAuth();
  const toast = useToast();
  const [c, setC] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    loadSetting('sheetsCopy').then((x) => setC({ url: '', key: '', autoSync: false, ...x })).catch(() => setC({ url: '', key: '', autoSync: false }));
  }, []);
  if (!c) return null;
  const run = async (what, fn) => {
    setBusy(what);
    setMsg(null);
    try {
      const r = await fn();
      if (r) setMsg(r);
    } catch (e) {
      setMsg({ kind: 'error', text: e.message });
    } finally {
      setBusy('');
    }
  };
  return (
    <section className="card">
      <h2>Google Sheets copy (for accounting)</h2>
      <p className="muted small">A read-only copy of all lists in a separate Google Sheet, using <code>google-apps-script/SheetsCopy.gs</code>. Works with any database.</p>
      <div className="grid-2">
        <Field label="Web app URL"><input value={c.url} onChange={(e) => setC({ ...c, url: e.target.value })} placeholder="https://script.google.com/macros/s/…/exec" /></Field>
        <Field label="Sync key" hint="Same as SYNC_KEY in the script"><input value={c.key} onChange={(e) => setC({ ...c, key: e.target.value })} /></Field>
        <label className="check span-2"><input type="checkbox" checked={!!c.autoSync} onChange={(e) => setC({ ...c, autoSync: e.target.checked })} /> Update the copy automatically once a day (when an admin opens the app)</label>
      </div>
      {msg && <div className={`alert alert-${msg.kind || 'ok'} mt`}>{msg.text}</div>}
      <div className="row-inline mt wrap">
        <button className="btn" disabled={!!busy} onClick={() => run('test', async () => {
          const r = await testSheetsCopy(c);
          return { kind: 'ok', text: `Connected to “${r.name}”.` };
        })}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
        <button className="btn" disabled={!!busy} onClick={() => run('save', async () => {
          await saveSheetsCopySettings({ url: c.url.trim(), key: c.key, autoSync: !!c.autoSync });
          toast('Google Sheets copy settings saved.');
        })}>Save</button>
        <button className="btn btn-primary" disabled={!!busy || !c.url} onClick={() => run('sync', async () => {
          const r = await syncToSheets(profile, (t) => setMsg({ kind: 'warn', text: t }));
          setC({ ...c, sheetUrl: r.url, lastSyncAt: new Date() });
          return { kind: 'ok', text: `Copied ${Object.values(r.counts || {}).reduce((a, b) => a + b, 0)} records.` };
        })}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>
        {c.sheetUrl && <a className="link" href={c.sheetUrl} target="_blank" rel="noreferrer">Open the Google Sheet →</a>}
      </div>
      {c.lastSyncAt && <p className="muted small mt">Last synced {fmtDateTime(c.lastSyncAt)}{c.lastSyncBy ? ` by ${c.lastSyncBy}` : ''}.</p>}
    </section>
  );
}

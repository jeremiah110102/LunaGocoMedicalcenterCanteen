// Read-only copy of the canteen's data in a Google Sheet (google-apps-script/SheetsCopy.gs),
// plus the automatic daily backup. Settings are shared by all devices (appSettings/*).
import { db, doc, getDoc, serverTimestamp, setDoc } from '../db';
import { APP } from '../config/app';
import { exportBackup, readAllCollections } from './backup';
import { logAudit } from '../lib/audit';

const DAY = 24 * 60 * 60 * 1000;
export const isAppsScriptUrl = (u) => /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec\/?$/.test(String(u || '').trim());

// Tab name → collection; private fields are never copied.
const TABLES = [
  ['Sales', 'sales'], ['Refunds', 'refunds'], ['Products', 'products'], ['Ingredients', 'ingredients'], ['Categories', 'categories'],
  ['Stock movements', 'stockMovements'], ['Stock counts', 'stockCounts'], ['Expiry batches', 'batches'],
  ['Suppliers', 'suppliers'], ['Purchase orders', 'purchaseOrders'], ['Deliveries', 'deliveries'], ['Supplier payments', 'supplierPayments'],
  ['Credit accounts', 'creditAccounts'], ['Credit payments', 'creditPayments'], ['Shifts', 'shifts'], ['Expenses', 'expenses'],
  ['Staff', 'staff', ['pinHash', 'pinSalt']],
];

/** One cell: dates as text, lists as JSON, and anything that looks like a formula kept as text. */
export function toCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v?.toDate === 'function') return v.toDate().toISOString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 49000);
  if (typeof v === 'string') return /^[=+\-@]/.test(v) ? `'${v}` : v.slice(0, 49000);
  return v;
}

export function buildTables(all) {
  return TABLES.map(([tab, name, drop = []]) => {
    const docs = all[name] || [];
    const keys = [...new Set(docs.flatMap((d) => Object.keys(d.data)))].filter((k) => !drop.includes(k)).sort();
    return { name: tab, headers: ['id', ...keys], rows: docs.map((d) => [d.id, ...keys.map((k) => toCell(d.data[k]))]) };
  });
}

async function post(url, payload) {
  let res;
  try {
    res = await fetch(url.trim(), { method: 'POST', body: JSON.stringify(payload), redirect: 'follow' });
  } catch {
    throw new Error('Couldn’t reach the Google Apps Script. Check the URL and your internet connection.');
  }
  let data;
  try {
    data = JSON.parse(await res.text());
  } catch {
    throw new Error('The script didn’t answer correctly. Deploy SheetsCopy.gs as a Web app (Who has access: Anyone).');
  }
  if (!data.ok) throw new Error(data.error || data.message || 'The Google Sheet refused the sync.');
  return data;
}

export async function loadSetting(id) {
  const s = await getDoc(doc(db, 'appSettings', id));
  return s.exists() ? s.data() : {};
}
const saveSetting = (id, data) => setDoc(doc(db, 'appSettings', id), { ...data, updatedAt: serverTimestamp() });

export async function testSheetsCopy({ url, key }) {
  if (!isAppsScriptUrl(url)) throw new Error('Paste the Web app URL (starts with https://script.google.com/macros/s/ and ends with /exec).');
  const r = await post(url, { action: 'test', key });
  if (r.app !== 'campus-canteen-pos-copy') throw new Error('That URL is not SheetsCopy.gs (maybe it is the Database.gs script).');
  return r;
}

export const saveSheetsCopySettings = async (s) => saveSetting('sheetsCopy', { ...(await loadSetting('sheetsCopy')), ...s });

export async function syncToSheets(profile, onStep = () => {}) {
  const cfg = await loadSetting('sheetsCopy');
  if (!cfg.url || !cfg.key) throw new Error('Set up the Google Sheets copy in Settings first.');
  onStep('Reading data…');
  const tables = buildTables(await readAllCollections());
  onStep(`Sending ${tables.reduce((t, x) => t + x.rows.length, 0)} records…`);
  const r = await post(cfg.url, { action: 'sync', key: cfg.key, canteen: APP.canteenName, syncedAt: new Date().toLocaleString(), syncedBy: profile.displayName, tables });
  await saveSetting('sheetsCopy', { ...cfg, lastSyncAt: serverTimestamp(), lastSyncBy: profile.displayName || '', lastCounts: r.counts || {}, sheetUrl: r.url || cfg.sheetUrl || '' });
  await logAudit(profile, 'sheets.sync', { counts: r.counts });
  return r;
}

const ageMs = (ts) => (ts?.toDate ? Date.now() - ts.toDate().getTime() : Infinity);

/**
 * Runs once when an admin opens the app: downloads the daily backup and refreshes the
 * Google Sheets copy if they are more than a day old (and switched on in Settings).
 */
export async function runDailyJobs(profile, notify = () => {}) {
  if (profile?.role !== 'admin') return;
  try {
    const b = await loadSetting('backup');
    if (b.autoDaily && ageMs(b.lastBackupAt) > DAY - 60 * 60 * 1000) {
      await exportBackup(profile, { label: 'daily' });
      await saveSetting('backup', { ...b, lastBackupAt: serverTimestamp(), lastBackupBy: profile.displayName || '' });
      notify('Daily backup downloaded.');
    }
  } catch (e) {
    notify(`Daily backup failed: ${e.message}`, 'error');
  }
  try {
    const s = await loadSetting('sheetsCopy');
    if (s.autoSync && s.url && ageMs(s.lastSyncAt) > DAY - 60 * 60 * 1000) {
      await syncToSheets(profile);
      notify('Google Sheets copy updated.');
    }
  } catch (e) {
    notify(`Google Sheets copy failed: ${e.message}`, 'error');
  }
}

export const saveBackupSettings = async (s) => saveSetting('backup', { ...(await loadSetting('backup')), ...s });

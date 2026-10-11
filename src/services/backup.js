import { db, batchSize, collection, doc, getDocs, writeBatch } from '../db';
import { auth } from '../firebase';
import { BACKUP_APP_ID, BACKUP_VERSION, COLLECTIONS, serializeDoc, cellToValue, validateWorkbook } from '../lib/backupFormat';
import { logAudit } from '../lib/audit';

const loadExcel = async () => (await import('exceljs')).default;

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Reads every backed-up collection from a database: { name: [{ id, data }] }. */
export async function readAllCollections(database = db) {
  const out = {};
  for (const { name } of COLLECTIONS) {
    const snap = await getDocs(collection(database, name));
    out[name] = snap.docs.map((d) => ({ id: d.id, data: d.data() }));
  }
  return out;
}

/** Exports every backed-up collection to an .xlsx workbook and downloads it. */
export async function exportBackup(profile, { label = 'backup' } = {}) {
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Campus Canteen POS';
  const exportedAt = new Date();

  const counts = {};
  const sheets = [];
  const all = await readAllCollections(db);
  for (const { name } of COLLECTIONS) {
    const rows = all[name].map((d) => serializeDoc(d.id, d.data));
    counts[name] = rows.length;
    sheets.push({ name, rows });
  }

  const meta = wb.addWorksheet('_meta');
  meta.columns = [{ header: 'key', key: 'key', width: 18 }, { header: 'value', key: 'value', width: 40 }];
  meta.addRows([
    { key: 'app', value: BACKUP_APP_ID },
    { key: 'version', value: BACKUP_VERSION },
    { key: 'exportedAt', value: exportedAt.toISOString() },
    { key: 'exportedBy', value: profile.displayName || profile.id },
    ...Object.entries(counts).map(([k, v]) => ({ key: `count.${k}`, value: v })),
  ]);

  for (const { name, rows } of sheets) {
    const ws = wb.addWorksheet(name);
    const keys = ['id', ...new Set(rows.flatMap((r) => Object.keys(r)).filter((k) => k !== 'id'))];
    ws.columns = keys.map((k) => ({ header: k, key: k, width: Math.min(Math.max(k.length + 4, 14), 40) }));
    ws.addRows(rows);
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  const buf = await wb.xlsx.writeBuffer();
  const stamp = exportedAt.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadBlob(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `canteen-${label}-${stamp}.xlsx`,
  );
  await logAudit(profile, 'backup.export', { label, counts });
  return counts;
}

/** Reads an .xlsx file and validates it. Does not write anything. */
export async function readBackupFile(file) {
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(await file.arrayBuffer());
  } catch {
    return { ok: false, errors: ['The file could not be opened as an Excel workbook.'], warnings: [], collections: {}, counts: {} };
  }
  const sheets = {};
  wb.eachSheet((ws) => {
    const header = [];
    ws.getRow(1).eachCell((c, col) => (header[col] = String(cellToValue(c.value)).trim()));
    const rows = [];
    ws.eachRow((row, i) => {
      if (i === 1) return;
      const obj = {};
      let any = false;
      header.forEach((h, col) => {
        if (!h) return;
        const v = cellToValue(row.getCell(col).value);
        if (v !== '') any = true;
        obj[h] = v;
      });
      if (any) rows.push(obj);
    });
    sheets[ws.name] = rows;
  });
  return validateWorkbook(sheets);
}

/** Compares the backup with current data: how many docs are new and how many will be overwritten. */
export async function previewRestore(parsed) {
  const preview = [];
  for (const { name } of COLLECTIONS) {
    const docs = parsed.collections[name];
    if (!docs) continue;
    const snap = await getDocs(collection(db, name));
    const current = new Set(snap.docs.map((d) => d.id));
    const overwrite = docs.filter((d) => current.has(d.id)).length;
    preview.push({ name, inFile: docs.length, current: current.size, overwrite, create: docs.length - overwrite });
  }
  return preview;
}

/**
 * Writes { name: [{ id, data }] } into a database, keeping the original IDs.
 * skipUid: a sign-in account record that must not be overwritten.
 */
export async function writeCollections(target, collections, { skipUid, onProgress } = {}) {
  const ops = [];
  for (const { name } of COLLECTIONS) {
    for (const d of collections[name] || []) {
      if (name === 'users' && d.id === skipUid) continue;
      ops.push({ name, id: d.id, data: d.data });
    }
  }
  const size = batchSize(target);
  let written = 0;
  try {
    for (let i = 0; i < ops.length; i += size) {
      const batch = writeBatch(target);
      for (const op of ops.slice(i, i + size)) batch.set(doc(target, op.name, op.id), op.data);
      await batch.commit();
      written += Math.min(size, ops.length - i);
      onProgress?.(written, ops.length);
    }
  } catch (e) {
    const err = new Error(`Stopped after ${written} of ${ops.length} records: ${e.message || e}`);
    err.written = written;
    throw err;
  }
  return { written, total: ops.length };
}

/**
 * Writes backup documents with their original IDs (so references between
 * sales, products, ingredients and accounts stay intact). Documents not in the
 * backup are left untouched. Written in batches of 400; if a batch fails the
 * error says how far it got, and the safety backup taken first can be restored.
 */
export async function restoreBackup(parsed, profile, { onProgress } = {}) {
  await logAudit(profile, 'backup.restore.start', { counts: parsed.counts, exportedAt: parsed.meta?.exportedAt || '' });
  try {
    // This device's sign-in account is never overwritten, so a restore can't lock it out.
    const { written } = await writeCollections(db, parsed.collections, { skipUid: auth.currentUser?.uid, onProgress });
    await logAudit(profile, 'backup.restore.done', { written, counts: parsed.counts });
    return written;
  } catch (e) {
    await logAudit(profile, 'backup.restore.failed', { written: e.written || 0, error: String(e.message || e) });
    throw new Error(`Restore failed. ${e.message}`);
  }
}

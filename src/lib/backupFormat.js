// Pure helpers for the Excel backup format — no Firebase or ExcelJS here, so it can be unit-tested.

export const BACKUP_APP_ID = 'campus-canteen-pos';
export const BACKUP_VERSION = 1;

// Every Firestore collection that is backed up. Order matters for restore (lookups first).
export const COLLECTIONS = [
  { name: 'users', dates: ['createdAt', 'updatedAt'], json: [] },
  { name: 'staff', dates: ['createdAt', 'updatedAt', 'pinUpdatedAt'], json: [] },
  { name: 'categories', dates: ['createdAt'], json: [] },
  { name: 'ingredients', dates: ['createdAt', 'updatedAt'], json: [] },
  { name: 'products', dates: ['createdAt', 'updatedAt'], json: ['recipe'] },
  { name: 'creditAccounts', dates: ['createdAt', 'updatedAt'], json: [] },
  { name: 'suppliers', dates: ['createdAt', 'updatedAt'], json: [] },
  { name: 'purchaseOrders', dates: ['createdAt', 'updatedAt', 'orderedAt', 'receivedAt', 'cancelledAt', 'lastDeliveryAt'], json: ['items'] },
  { name: 'deliveries', dates: ['createdAt', 'receivedAt', 'updatedAt'], json: ['items'] },
  { name: 'supplierPayments', dates: ['createdAt', 'paidAt'], json: ['allocations'] },
  { name: 'batches', dates: ['createdAt', 'closedAt', 'updatedAt'], json: [] },
  { name: 'stockCounts', dates: ['createdAt', 'updatedAt', 'postedAt'], json: ['items', 'result'] },
  { name: 'shifts', dates: ['createdAt', 'openedAt', 'closedAt', 'updatedAt'], json: ['cashEvents', 'counts', 'summary'] },
  { name: 'expenses', dates: ['createdAt', 'updatedAt'], json: [] },
  { name: 'refunds', dates: ['createdAt'], json: ['lines'] },
  { name: 'appSettings', dates: ['updatedAt', 'lastBackupAt', 'lastSyncAt'], json: ['lastCounts'] },
  { name: 'counters', dates: [], json: [] },
  { name: 'sales', dates: ['createdAt', 'updatedAt'], json: ['items', 'refundedQty', 'reviewNotes'] },
  { name: 'creditPayments', dates: ['createdAt'], json: [] },
  { name: 'stockMovements', dates: ['createdAt'], json: [] },
  { name: 'auditLogs', dates: ['createdAt'], json: ['details'] },
];

const SPEC = Object.fromEntries(COLLECTIONS.map((c) => [c.name, c]));

const isTimestamp = (v) => v && typeof v === 'object' && typeof v.toDate === 'function';

/** Firestore document → flat row for a worksheet. */
export function serializeDoc(id, data) {
  const row = { id };
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) row[k] = '';
    else if (isTimestamp(v)) row[k] = v.toDate().toISOString();
    else if (v instanceof Date) row[k] = v.toISOString();
    else if (typeof v === 'object') row[k] = JSON.stringify(v);
    else row[k] = v;
  }
  return row;
}

/** Normalises an ExcelJS cell value to a plain JS value. */
export function cellToValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if ('result' in v) return cellToValue(v.result);
    if ('text' in v) return v.text;
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
  }
  return v;
}

/**
 * Worksheet row → { id, data, errors }. Dates come back as Date objects (the restore service
 * turns them into Firestore Timestamps); JSON columns are parsed; blank cells are dropped.
 */
export function deserializeRow(collection, row) {
  const spec = SPEC[collection];
  const errors = [];
  const id = String(row.id ?? '').trim();
  if (!id) errors.push('missing id');
  if (id.includes('/')) errors.push(`invalid id "${id}"`);
  const data = {};
  for (const [k, raw] of Object.entries(row)) {
    if (k === 'id' || raw === '' || raw === null || raw === undefined) continue;
    if (spec.json.includes(k)) {
      try {
        data[k] = typeof raw === 'string' ? JSON.parse(raw) : raw;
      } catch {
        errors.push(`column "${k}" is not valid JSON`);
      }
    } else if (spec.dates.includes(k)) {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) errors.push(`column "${k}" is not a valid date`);
      else data[k] = d;
    } else {
      data[k] = raw;
    }
  }
  return { id, data, errors };
}

/**
 * sheets: { [sheetName]: rowObject[] }
 * Returns { ok, errors, warnings, collections: { name: [{id, data}] }, counts }
 */
export function validateWorkbook(sheets) {
  const errors = [];
  const warnings = [];
  const collections = {};
  const counts = {};

  const meta = Object.fromEntries((sheets._meta || []).map((r) => [r.key, r.value]));
  if (meta.app !== BACKUP_APP_ID) {
    errors.push('This file is not a Campus Canteen POS backup (missing or wrong _meta sheet).');
    return { ok: false, errors, warnings, collections, counts, meta };
  }
  if (Number(meta.version) > BACKUP_VERSION) {
    errors.push(`Backup version ${meta.version} is newer than this app supports (${BACKUP_VERSION}).`);
  }

  for (const name of Object.keys(sheets)) {
    if (name !== '_meta' && !SPEC[name]) warnings.push(`Ignoring unrecognised sheet "${name}".`);
  }

  for (const { name } of COLLECTIONS) {
    const rows = sheets[name];
    if (!rows) continue;
    const seen = new Set();
    const docs = [];
    rows.forEach((row, i) => {
      const { id, data, errors: rowErrs } = deserializeRow(name, row);
      const line = i + 2; // header is row 1
      rowErrs.forEach((e) => errors.push(`${name} row ${line}: ${e}`));
      if (id && seen.has(id)) errors.push(`${name} row ${line}: duplicate id "${id}"`);
      seen.add(id);
      if (!rowErrs.length) docs.push({ id, data });
    });
    collections[name] = docs;
    counts[name] = docs.length;
  }

  if (!Object.keys(collections).length) errors.push('No recognised data sheets found.');
  if (collections.staff && !collections.staff.some((u) => u.data.role === 'admin' && u.data.active !== false)) {
    errors.push('The staff sheet has no active admin; restoring it could lock everyone out.');
  }

  return { ok: errors.length === 0, errors, warnings, collections, counts, meta };
}

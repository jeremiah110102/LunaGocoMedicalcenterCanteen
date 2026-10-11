/**
 * ==========================================================
 * Campus Canteen POS — GOOGLE SHEETS DATABASE
 * ==========================================================
 * Makes this Google Sheet the canteen's database. Firebase is still used for
 * sign-in: every request carries a Firebase sign-in token, which this script
 * checks with Firebase, and the rules below (same as firestore.rules) decide
 * what that account may do.
 *
 * Each list is a tab (products, sales, …):
 *   column A  _id    record id
 *   column B  _v     version (changes on every save)
 *   column C  _json  the full record — this is the real data (hidden)
 *   columns D+       readable copies of each field, for viewing and filtering
 * Edit records in the app, not in the sheet: the readable columns are not read back.
 *
 * SETUP (about 5 minutes)
 *  1. Create a new Google Sheet → Extensions → Apps Script. Delete the sample
 *     code, paste this whole file, and click Save.
 *  2. Put your Firebase apiKey in FIREBASE_API_KEY below (Firebase console →
 *     Project settings → General → Web API key). Save.
 *  3. Choose "authorize" in the toolbar → Run → allow the permissions.
 *  4. Deploy → New deployment → gear icon → Web app:
 *        Execute as:      Me
 *        Who has access:  Anyone
 *     Deploy, then copy the Web app URL (ends with /exec).
 *  5. In the app: Settings → Database → Google Sheets → paste the URL → Test → Switch.
 *
 * "Anyone" only lets the website reach this script. Every request must carry a valid
 * Firebase sign-in from YOUR Firebase project (checked with the apiKey above).
 * After editing this code: Deploy → Manage deployments → Edit → Version: New version → Deploy.
 */

const FIREBASE_API_KEY = 'PASTE-your-Firebase-apiKey-here';
const APP = 'campus-canteen-pos';
const VERSION = 1;

/** Run once from the editor to grant permissions (reads only). */
function authorize() {
  SpreadsheetApp.getActiveSpreadsheet().getName();
  UrlFetchApp.fetch('https://www.google.com/generate_204', { muteHttpExceptions: true });
  CacheService.getScriptCache().get('authorize-check');
  LockService.getScriptLock();
}

// ---------------------------------------------------------- entry points
function doGet() {
  return reply({ ok: true, app: APP, version: VERSION, message: 'Campus Canteen POS database is running. Use this URL in the app.' });
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, code: 'invalid-argument', message: 'Bad request.' });
  }
  try {
    const ctx = makeContext(body.token);
    switch (body.action) {
      case 'ping':
        return reply({
          ok: true, app: APP, version: VERSION,
          name: SpreadsheetApp.getActiveSpreadsheet().getName(),
          signedIn: !!ctx.r.uid, uid: ctx.r.uid,
        });
      case 'get': {
        const p = parsePath(body.path);
        const d = loadCol(ctx, p.col).map[p.id];
        if (!d) return reply({ ok: true, doc: null });
        if (!canRead(ctx.r, p.col, p.id)) fail('permission-denied', 'You do not have access to this record.');
        return reply({ ok: true, doc: { id: p.id, data: d.data, v: d.v } });
      }
      case 'getMany': {
        const out = {};
        (body.paths || []).forEach(function (path) {
          const p = parsePath(path);
          if (!canRead(ctx.r, p.col, p.id)) fail('permission-denied', 'You do not have access to ' + path + '.');
          const d = loadCol(ctx, p.col).map[p.id];
          if (d) out[path] = { id: p.id, data: d.data, v: d.v };
        });
        return reply({ ok: true, docs: out });
      }
      case 'query':
        return reply({ ok: true, docs: runQuery(ctx, body) });
      case 'commit': {
        const lock = LockService.getScriptLock();
        lock.waitLock(25000); // one save at a time keeps stock and receipt numbers right
        try {
          ctx.cols = {}; // re-read under the lock
          commit(ctx, body.ops || [], body.pre || []);
        } finally {
          lock.releaseLock();
        }
        return reply({ ok: true });
      }
      default:
        return reply({ ok: false, code: 'invalid-argument', message: 'Unknown action.' });
    }
  } catch (err) {
    if (err && err.code) return reply({ ok: false, code: err.code, message: err.message });
    const msg = String((err && err.message) || err);
    if (/UrlFetchApp|permission/i.test(msg)) {
      return reply({ ok: false, code: 'failed-precondition', message: 'The script needs permission: in Apps Script choose "authorize", click Run, allow, then Deploy → Manage deployments → Edit → New version.' });
    }
    return reply({ ok: false, code: 'internal', message: msg });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}

// ---------------------------------------------------------- sign-in
function verifyToken(token) {
  if (!token) return null;
  if (/^PASTE-/.test(FIREBASE_API_KEY)) {
    fail('failed-precondition', 'Put your Firebase apiKey in FIREBASE_API_KEY at the top of Database.gs, save, and deploy a new version.');
  }
  const cache = CacheService.getScriptCache();
  const key = 'tok:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  const hit = cache.get(key);
  if (hit) return hit === '-' ? null : hit;
  const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(FIREBASE_API_KEY), {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: token }), muteHttpExceptions: true,
  });
  let uid = null;
  if (res.getResponseCode() === 200) {
    const users = JSON.parse(res.getContentText()).users || [];
    uid = users.length && users[0].localId ? users[0].localId : null;
  } else {
    const msg = String(res.getContentText());
    if (/API key not valid|API_KEY_INVALID/.test(msg)) fail('failed-precondition', 'Firebase rejected FIREBASE_API_KEY in Database.gs. Copy the Web API key again from Firebase project settings.');
  }
  cache.put(key, uid || '-', uid ? 300 : 60);
  return uid;
}

function makeContext(token) {
  const ctx = { cols: {} };
  const uid = verifyToken(token);
  const me = uid ? loadCol(ctx, 'users').map[uid] : null;
  const d = me ? me.data : null;
  const device = !!(d && d.active === true && (d.role === 'admin' || d.role === 'device'));
  ctx.r = { uid: uid, signedIn: !!uid, device: device, owner: device && d.role === 'admin' };
  return ctx;
}

// ---------------------------------------------------------- storage
function parsePath(path) {
  const parts = String(path || '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1] || !/^[A-Za-z]+$/.test(parts[0])) fail('invalid-argument', 'Bad record path: ' + path);
  return { col: parts[0], id: parts[1] };
}

function loadCol(ctx, name) {
  if (ctx.cols[name]) return ctx.cols[name];
  const out = { map: {}, ids: [], header: [], sheet: null };
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (sheet && sheet.getLastRow() >= 1) {
    const values = sheet.getDataRange().getValues();
    out.header = values[0].map(String);
    for (let i = 1; i < values.length; i++) {
      const id = String(values[i][0]);
      if (!id) continue;
      let data;
      try {
        data = JSON.parse(values[i][2]);
      } catch (e) {
        continue; // a damaged row is skipped rather than breaking the whole list
      }
      out.map[id] = { data: data, v: Number(values[i][1]) || 1, row: i + 1 };
      out.ids.push(id);
    }
  }
  out.sheet = sheet;
  ctx.cols[name] = out;
  return out;
}

function cellOf(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && typeof v.__ts === 'string') return v.__ts;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 49000);
  if (typeof v === 'string') {
    const s = v.length > 49000 ? v.slice(0, 49000) : v;
    return /^[=+\-@]/.test(s) ? "'" + s : s; // never let data run as a formula
  }
  return v;
}

/** changes: { id: { data, v } | null } */
function persist(ctx, name, changes) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const before = loadCol(ctx, name);
  let sheet = before.sheet;
  let header = before.header.slice();
  if (!sheet) {
    sheet = ss.insertSheet(name);
    header = ['_id', '_v', '_json'];
  }
  if (header.length < 3) header = ['_id', '_v', '_json'];
  const ids = Object.keys(changes);
  ids.forEach(function (id) {
    const c = changes[id];
    if (c) Object.keys(c.data).forEach(function (k) { if (header.indexOf(k) < 0) header.push(k); });
  });
  if (header.join('\u0001') !== before.header.join('\u0001')) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    if (!before.sheet) {
      sheet.setFrozenRows(1);
      sheet.hideColumns(3);
    }
  }
  const rowFor = function (id, c) {
    return header.map(function (h, i) { return i === 0 ? id : i === 1 ? c.v : i === 2 ? JSON.stringify(c.data) : cellOf(c.data[h]); });
  };
  const updates = ids.filter(function (id) { return changes[id] && before.map[id]; });
  const inserts = ids.filter(function (id) { return changes[id] && !before.map[id]; });
  const deletes = ids.filter(function (id) { return !changes[id] && before.map[id]; });
  updates.forEach(function (id) {
    sheet.getRange(before.map[id].row, 1, 1, header.length).setValues([rowFor(id, changes[id])]);
  });
  deletes.map(function (id) { return before.map[id].row; }).sort(function (a, b) { return b - a; })
    .forEach(function (r) { sheet.deleteRow(r); });
  if (inserts.length) {
    const rows = inserts.map(function (id) { return rowFor(id, changes[id]); });
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
  }
  delete ctx.cols[name];
}

// ---------------------------------------------------------- rules (same as firestore.rules)
const isNum = function (v) { return typeof v === 'number' && isFinite(v); };
const isStr = function (v) { return typeof v === 'string' && v.length > 0; };
const nonNeg = function (v) { return isNum(v) && v >= 0; };
/** Only the listed keys differ between b and a. */
function changedOnly(b, a, allowed) {
  const keys = {};
  Object.keys(b || {}).forEach(function (k) { keys[k] = 1; });
  Object.keys(a || {}).forEach(function (k) { keys[k] = 1; });
  return Object.keys(keys).every(function (k) { return same((b || {})[k], (a || {})[k]) || allowed.indexOf(k) >= 0; });
}

function canRead(r, col, id) {
  if (col === 'settings') return id === 'setup' && r.signedIn;
  if (col === 'users') return r.signedIn && (r.uid === id || r.owner);
  return r.device;
}

/** b = record before, a = after; after(col, id) = state after the whole commit. */
function canWrite(r, kind, col, id, b, a, after, before) {
  switch (col) {
    case 'settings':
      return id === 'setup' && kind === 'create' && r.signedIn && a.ownerUid === r.uid &&
        !!after('users', r.uid) && after('users', r.uid).role === 'admin';
    case 'users': {
      const allowedKeys = ['email', 'displayName', 'role', 'active', 'createdAt'];
      if (kind === 'create' && r.signedIn && r.uid === id && a.active === true &&
          Object.keys(a).every(function (k) { return allowedKeys.indexOf(k) >= 0; }) &&
          (a.role === 'pending' ||
            (a.role === 'admin' && !before('settings', 'setup') &&
              !!after('settings', 'setup') && after('settings', 'setup').ownerUid === r.uid))) return true;
      return r.owner && r.uid !== id && (kind === 'create' || kind === 'update') &&
        (a.role === 'device' || a.role === 'pending') && (!b || b.role !== 'admin');
    }
    case 'staff':
      return r.device && (kind === 'create' || kind === 'update') && isStr(a.name) &&
        ['admin', 'manager', 'cashier', 'inventory', 'accountant'].indexOf(a.role) >= 0 && isStr(a.pinHash) && isStr(a.pinSalt);
    case 'categories':
    case 'suppliers':
      return r.device;
    case 'products':
      return r.device && (kind === 'delete' || ((!('stock' in a) || isNum(a.stock)) && nonNeg(a.price)));
    case 'ingredients':
      // stock may go below zero when out-of-stock items are sold anyway
      return r.device && (kind === 'delete' || !('stock' in a) || isNum(a.stock));
    case 'purchaseOrders':
      return r.device && (kind === 'create' || kind === 'update');
    case 'deliveries':
      return (r.device && kind === 'create' && Array.isArray(a.items) && a.items.length > 0 && nonNeg(a.total)) ||
        (r.device && kind === 'update' && changedOnly(b, a, ['paidAmount', 'paymentStatus', 'updatedAt']) && nonNeg(a.paidAmount)) ||
        (r.owner && kind !== 'delete');
    case 'supplierPayments':
      return (r.device && kind === 'create' && isNum(a.amount) && a.amount > 0) || (r.owner && kind !== 'delete');
    case 'refunds':
      return (r.device && kind === 'create' && Array.isArray(a.lines) && a.lines.length > 0 && nonNeg(a.amount) &&
          isStr(a.approvedById) && a.accountUid === r.uid) || (r.owner && kind !== 'delete');
    case 'shifts':
    case 'stockCounts':
    case 'batches':
      return r.device && (kind === 'create' || kind === 'update');
    case 'expenses':
      return r.device && (kind === 'create' || kind === 'update') && isNum(a.amount) && a.amount > 0;
    case 'appSettings':
      return r.device;
    case 'stockMovements':
      return (r.device && kind === 'create' && isNum(a.change)) || (r.owner && kind !== 'delete');
    case 'counters':
      return ['sales', 'purchaseOrders', 'deliveries', 'refunds', 'shifts', 'stockCounts', 'supplierPayments'].indexOf(id) >= 0 && (
        (r.device && kind === 'create' && a.next === 1) ||
        (r.device && kind === 'update' && isNum(a.next) && isNum(b.next) && a.next === b.next + 1) ||
        (r.owner && kind !== 'delete'));
    case 'sales':
      return (r.device && kind === 'create' && Array.isArray(a.items) && a.items.length > 0 && nonNeg(a.total) &&
          ['cash', 'gcash', 'credit'].indexOf(a.paymentMethod) >= 0 && isStr(a.cashierId) && a.accountUid === r.uid) ||
        // a sale is never changed, except to note how much of it was refunded
        (r.device && kind === 'update' && changedOnly(b, a, ['refundedQty', 'refundedTotal', 'refundStatus', 'updatedAt']) &&
          nonNeg(a.refundedTotal) && a.refundedTotal <= b.total) ||
        (r.owner && kind !== 'delete');
    case 'creditAccounts':
      return (r.device && (kind === 'create' || kind === 'update') && nonNeg(a.balance) && nonNeg(a.limit)) ||
        (r.owner && kind !== 'delete');
    case 'creditPayments':
      return (r.device && kind === 'create' && isNum(a.amount) && a.amount > 0) || (r.owner && kind !== 'delete');
    case 'auditLogs':
      return (r.device && kind === 'create' && a.accountUid === r.uid) || (r.owner && kind !== 'delete');
    default:
      return false;
  }
}

// ---------------------------------------------------------- writes
function resolveServerTimes(v, nowIso) {
  if (Array.isArray(v)) return v.map(function (x) { return resolveServerTimes(x, nowIso); });
  if (v && typeof v === 'object') {
    if (v.__serverTimestamp === true) return { __ts: nowIso };
    const o = {};
    Object.keys(v).forEach(function (k) { o[k] = resolveServerTimes(v[k], nowIso); });
    return o;
  }
  return v;
}

function commit(ctx, ops, pre) {
  if (!ops.length) return;
  pre.forEach(function (p) {
    const x = parsePath(p.path);
    const cur = loadCol(ctx, x.col).map[x.id];
    if ((cur ? cur.v : 0) !== (Number(p.v) || 0)) fail('aborted', 'A record changed while saving: ' + p.path);
  });

  const nowIso = new Date().toISOString();
  const afterMap = {};
  const planned = [];
  const before = function (col, id) { const d = loadCol(ctx, col).map[id]; return d ? d.data : null; };
  const after = function (col, id) { const k = col + '/' + id; return k in afterMap ? afterMap[k] : before(col, id); };

  ops.forEach(function (op) {
    const x = parsePath(op.path);
    const k = x.col + '/' + x.id;
    const cur = after(x.col, x.id);
    const dat = resolveServerTimes(op.data, nowIso);
    let nxt;
    if (op.type === 'delete') nxt = null;
    else if (op.type === 'update') {
      if (!cur) fail('not-found', 'No record to update: ' + k);
      nxt = Object.assign({}, cur, dat || {});
    } else if (op.type === 'set') nxt = dat || {};
    else fail('invalid-argument', 'Unknown write: ' + op.type);
    afterMap[k] = nxt;
    planned.push({ type: op.type, col: x.col, id: x.id, before: before(x.col, x.id), after: nxt });
  });

  planned.forEach(function (p) {
    if (p.type === 'delete' && !p.before) return;
    const kind = p.type === 'delete' ? 'delete' : p.before ? 'update' : 'create';
    if (!canWrite(ctx.r, kind, p.col, p.id, p.before, p.after, after, before)) {
      fail('permission-denied', 'Not allowed: ' + kind + ' in ' + p.col + '.');
    }
  });

  const byCol = {};
  Object.keys(afterMap).forEach(function (k) {
    const x = parsePath(k);
    const cur = loadCol(ctx, x.col).map[x.id];
    byCol[x.col] = byCol[x.col] || {};
    byCol[x.col][x.id] = afterMap[k] === null ? null : { data: afterMap[k], v: (cur ? cur.v : 0) + 1 };
  });
  Object.keys(byCol).forEach(function (col) { persist(ctx, col, byCol[col]); });
}

// ---------------------------------------------------------- queries
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function textKey(v) {
  if (v === null || v === undefined || typeof v === 'number') return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && typeof v.__ts === 'string') return v.__ts;
  return JSON.stringify(v);
}
function cmp(a, b) {
  if (isNum(a) && isNum(b)) return a < b ? -1 : a > b ? 1 : 0;
  const ta = textKey(a), tb = textKey(b);
  if (ta === null || tb === null) return null;
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}
function matches(d, w) {
  const v = d[w[0]], op = w[1], val = w[2];
  if (op === '==') return v !== undefined && same(v, val);
  if (op === '!=') return v !== undefined && !same(v, val);
  if (op === 'in') return v !== undefined && (val || []).some(function (x) { return same(x, v); });
  const c = cmp(v, val);
  if (c === null) return false;
  return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : false;
}

function runQuery(ctx, q) {
  const col = q.collection;
  if (!col) fail('invalid-argument', 'Missing collection name.');
  const data = loadCol(ctx, col);
  let rows = data.ids
    .map(function (id) { return { id: id, data: data.map[id].data, v: data.map[id].v }; })
    .filter(function (x) { return (q.where || []).every(function (w) { return matches(x.data, w); }) && canRead(ctx.r, col, x.id); });
  const orders = q.orderBy || [];
  rows.sort(function (x, y) {
    for (let i = 0; i < orders.length; i++) {
      const f = orders[i][0], dir = orders[i][1] === 'desc' ? -1 : 1;
      const a = x.data[f], b = y.data[f];
      const an = a === undefined || a === null, bn = b === undefined || b === null;
      if (an || bn) { if (an !== bn) return an ? 1 : -1; continue; } // missing values last
      const c = cmp(a, b);
      if (c) return c * dir;
    }
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
  if (q.limit > 0) rows = rows.slice(0, q.limit);
  return rows;
}

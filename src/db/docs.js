// Document store over plain requests — used for Supabase (supabase/schema.sql)
// and Google Sheets (google-apps-script/Database.gs). Both answer the same actions:
//   ping · get {path} · getMany {paths} · query {collection, where, orderBy, limit} · commit {ops, pre}
// Every record has a version number "v". A commit can carry preconditions
// ("this record must still be at version v"); if anyone changed it meanwhile the
// server answers code "aborted" and runTransaction() retries with fresh data.

import { decode, encode } from './encoding';

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function autoId() {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return [...b].map((x) => ID_CHARS[x % ID_CHARS.length]).join('');
}

export class DbError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/* ---------------- the db object ---------------- */

/** kind: 'supabase' | 'sheets' */
export function createDocsDb({ kind, url, key = '', getToken }) {
  return {
    __docs: true,
    kind,
    url: String(url).trim().replace(/\/+$/, ''),
    key: String(key).trim(),
    getToken,
    pollMs: kind === 'sheets' ? 20000 : 8000,
    listeners: new Set(),
    active: 0,
    waiting: [],
  };
}

/* ---------------- transport ---------------- */

async function slot(db) {
  const max = db.kind === 'sheets' ? 4 : 8;
  if (db.active < max) {
    db.active++;
    return;
  }
  await new Promise((r) => db.waiting.push(r));
  db.active++;
}
function release(db) {
  db.active--;
  db.waiting.shift()?.();
}

/** Sends one request. Exported for the connection test. */
export async function send(db, body, { token: forcedToken } = {}) {
  await slot(db);
  try {
    const token = forcedToken !== undefined ? forcedToken : await db.getToken?.();
    let res;
    try {
      if (db.kind === 'supabase') {
        res = await fetch(`${db.url}/rest/v1/rpc/pos_request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: db.key, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ body }),
        });
      } else {
        // text/plain keeps it a "simple" request, which Apps Script accepts from any website
        res = await fetch(db.url, { method: 'POST', body: JSON.stringify({ ...body, token }), redirect: 'follow' });
      }
    } catch {
      throw new DbError('unavailable', `Can't reach the ${db.kind === 'supabase' ? 'Supabase' : 'Google Sheets'} database. Check the address and your internet connection.`);
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (db.kind === 'supabase' && !res.ok) {
      const msg = data?.message || data?.msg || data?.error || `HTTP ${res.status}`;
      if (res.status === 404 || data?.code === 'PGRST202') throw new DbError('failed-precondition', 'The Supabase project is not set up yet. Run supabase/schema.sql in its SQL Editor.');
      if ((res.status === 401 || res.status === 403) && token) throw new DbError('unauthenticated', `Supabase did not accept the Firebase sign-in (${msg}). Add Firebase under Authentication → Third-party Auth in Supabase.`);
      if (res.status === 401 || res.status === 403) throw new DbError('failed-precondition', `Supabase refused the key (${msg}). Use the publishable or anon public key.`);
      throw new DbError('internal', `Supabase error: ${msg}`);
    }
    if (!data || typeof data !== 'object') {
      throw new DbError('unavailable', db.kind === 'sheets'
        ? 'The Google Sheets script did not answer correctly. Deploy Database.gs as a Web app (Who has access: Anyone) and use the URL ending in /exec.'
        : 'The Supabase database did not answer correctly. Run supabase/schema.sql again.');
    }
    if (!data.ok) throw new DbError(data.code || 'internal', data.message || 'The database refused the request.');
    return data;
  } finally {
    release(db);
  }
}

/* ---------------- references ---------------- */

export const collectionRef = (db, name) => ({ __docs: true, type: 'collection', db, id: name, path: name });

export function docRef(a, b, c) {
  if (a.type === 'collection') {
    const id = b || autoId();
    return { __docs: true, type: 'doc', db: a.db, id, col: a.path, path: `${a.path}/${id}` };
  }
  const id = c || autoId();
  return { __docs: true, type: 'doc', db: a, id, col: b, path: `${b}/${id}` };
}

export const queryRef = (base, constraints) => ({
  __docs: true,
  type: 'query',
  db: base.db,
  path: base.path,
  constraints: [...(base.constraints || []), ...constraints],
});

function spec(q) {
  const cs = q.constraints || [];
  return {
    collection: q.path,
    where: cs.filter((c) => c.kind === 'where').map((c) => [c.field, c.op, encode(c.value)]),
    orderBy: cs.filter((c) => c.kind === 'orderBy').map((c) => [c.field, c.dir]),
    limit: cs.find((c) => c.kind === 'limit')?.n || null,
  };
}

/* ---------------- snapshots ---------------- */

function docSnap(ref, raw) {
  let cached;
  return {
    id: ref.id,
    ref,
    exists: () => raw !== null && raw !== undefined,
    data: () => (raw ? (cached ??= decode(raw)) : undefined),
  };
}

function querySnap(q, rows) {
  const base = collectionRef(q.db, q.path);
  const docs = rows.map((r) => docSnap(docRef(base, r.id), r.data));
  return { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) };
}

/* ---------------- reads ---------------- */

export async function getDoc(ref) {
  const r = await send(ref.db, { action: 'get', path: ref.path });
  return docSnap(ref, r.doc ? r.doc.data : null);
}

export async function getDocs(q) {
  const r = await send(q.db, { action: 'query', ...spec(q.type === 'collection' ? queryRef(q, []) : q) });
  return querySnap(q, r.docs || []);
}

/* ---------------- writes ---------------- */

const op = (type, ref, data) => ({ type, path: ref.path, ...(data !== undefined ? { data: encode(data) } : {}) });

export async function commit(db, ops, pre = []) {
  if (!ops.length) return;
  await send(db, { action: 'commit', ops, pre });
  refreshListeners(db);
}

export const setDoc = (ref, data) => commit(ref.db, [op('set', ref, data)]);
export const updateDoc = (ref, data) => commit(ref.db, [op('update', ref, data)]);
export const deleteDoc = (ref) => commit(ref.db, [op('delete', ref)]);
export async function addDoc(col, data) {
  const ref = docRef(col);
  await setDoc(ref, data);
  return ref;
}

export function writeBatch(db) {
  const ops = [];
  const batch = {
    set: (ref, data) => (ops.push(op('set', ref, data)), batch),
    update: (ref, data) => (ops.push(op('update', ref, data)), batch),
    delete: (ref) => (ops.push(op('delete', ref)), batch),
    commit: () => commit(db, ops),
  };
  return batch;
}

/**
 * Optimistic transaction: reads remember each record's version; the commit is
 * rejected ("aborted") if any of them changed, and the whole function runs again.
 * Reads made in the same tick are sent as one request.
 */
export async function runTransaction(db, fn, { attempts = 5 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const seen = new Map(); // path → { v, data }
    const inflight = new Map(); // path → promise
    let pending = null; // reads collected during the current tick
    const ops = [];

    const flush = async (paths) => {
      const r = await send(db, { action: 'getMany', paths });
      for (const p of paths) {
        const d = r.docs?.[p];
        seen.set(p, { v: d ? d.v : 0, data: d ? d.data : null });
      }
    };
    const load = (path) => {
      if (inflight.has(path)) return inflight.get(path);
      if (!pending) {
        const group = { paths: [] };
        group.promise = Promise.resolve().then(() => {
          pending = null;
          return flush(group.paths);
        });
        pending = group;
      }
      pending.paths.push(path);
      inflight.set(path, pending.promise);
      return pending.promise;
    };

    const tx = {
      async get(ref) {
        await load(ref.path);
        return docSnap(ref, seen.get(ref.path).data);
      },
      set(ref, data) {
        ops.push(op('set', ref, data));
        return tx;
      },
      update(ref, data) {
        ops.push(op('update', ref, data));
        return tx;
      },
      delete(ref) {
        ops.push(op('delete', ref));
        return tx;
      },
    };

    const result = await fn(tx);
    const pre = [...seen].map(([path, r]) => ({ path, v: r.v }));
    try {
      await commit(db, ops, pre);
      return result;
    } catch (e) {
      if (e.code !== 'aborted' || attempt >= attempts) {
        if (e.code === 'aborted') e.message = 'Someone else changed the same records at the same moment. Please try again.';
        throw e;
      }
      await new Promise((r) => setTimeout(r, 150 * attempt + Math.random() * 200));
    }
  }
}

/* ---------------- "live" updates (polling) ---------------- */

function refreshListeners(db) {
  for (const l of db.listeners) l.refresh();
}

export function onSnapshot(target, next, error) {
  const db = target.db;
  let stopped = false;
  let timer = null;
  let running = false;
  const run = async () => {
    if (stopped || running) return;
    running = true;
    clearTimeout(timer);
    try {
      const snap = target.type === 'doc' ? await getDoc(target) : await getDocs(target);
      if (!stopped) next(snap);
    } catch (e) {
      if (!stopped) error?.(e);
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(run, typeof document !== 'undefined' && document.hidden ? db.pollMs * 4 : db.pollMs);
    }
  };
  const listener = { refresh: () => setTimeout(run, 0) };
  db.listeners.add(listener);
  run();
  return () => {
    stopped = true;
    clearTimeout(timer);
    db.listeners.delete(listener);
  };
}

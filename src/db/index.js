// The one database API the whole app uses. Same names and shapes as Firestore's
// modular SDK, so pages read the same whichever database is selected:
//   Firebase Firestore → the real Firestore SDK
//   Supabase / Google Sheets → ./docs.js (requests to schema.sql / Database.gs)
// Firebase Authentication is used for sign-in in every case.

import * as FS from 'firebase/firestore';
import * as D from './docs';
import { SERVER_TIME, isServerTime } from './encoding';
import { auth, homeDb } from '../firebase';
import { loadChoice, normalizeChoice } from './connection';

export const BACKENDS = { firestore: 'Firebase Firestore', supabase: 'Supabase', sheets: 'Google Sheets' };

/** The active database (assigned by initDb before the app renders). */
export let db = homeDb;
/** 'firestore' | 'supabase' | 'sheets' */
export let backend = 'firestore';
/** The full active choice, e.g. { backend, supabaseUrl, supabaseKey, sheetsUrl, ownerUids } */
export let connection = { backend: 'firestore' };

const signInToken = () => (auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null));

/** Builds a database handle for a choice (used for the active db and for switching/copying). */
export function makeDb(choice) {
  const c = normalizeChoice(choice);
  if (c.backend === 'supabase') return D.createDocsDb({ kind: 'supabase', url: c.supabaseUrl, key: c.supabaseKey, getToken: signInToken });
  if (c.backend === 'sheets') return D.createDocsDb({ kind: 'sheets', url: c.sheetsUrl, getToken: signInToken });
  return homeDb;
}

/** Points the whole app at a database (also used by tests). */
export function setActiveDatabase(handle, choice) {
  db = handle;
  connection = choice;
  backend = choice.backend;
}

export async function initDb() {
  const choice = await loadChoice();
  setActiveDatabase(makeDb(choice), choice);
  return choice;
}

/* ---------------- constraints (neutral) ---------------- */
export const where = (field, op, value) => ({ kind: 'where', field, op, value });
export const orderBy = (field, dir = 'asc') => ({ kind: 'orderBy', field, dir });
export const limit = (n) => ({ kind: 'limit', n });
export const serverTimestamp = () => SERVER_TIME;

const toFsConstraint = (c) =>
  c.kind === 'where' ? FS.where(c.field, c.op, c.value) : c.kind === 'orderBy' ? FS.orderBy(c.field, c.dir) : FS.limit(c.n);

const isDocs = (x) => !!x && x.__docs === true;
const isPlain = (v) => v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

/** Prepares data for Firestore: server-time sentinels and foreign timestamps. */
function toFs(v) {
  if (isServerTime(v)) return FS.serverTimestamp();
  if (Array.isArray(v)) return v.map(toFs);
  if (v && typeof v === 'object' && !(v instanceof FS.Timestamp) && typeof v.toDate === 'function') return v.toDate();
  if (isPlain(v)) return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, toFs(x)]));
  return v;
}

/* ---------------- references ---------------- */
export function collection(database, name) {
  return isDocs(database) ? D.collectionRef(database, name) : FS.collection(database, name);
}

/** doc(db, 'col', id) · doc(collectionRef) for a new id · doc(collectionRef, id) */
export function doc(a, b, c) {
  if (isDocs(a)) return D.docRef(a, b, c);
  if (a instanceof FS.CollectionReference) return b ? FS.doc(a, b) : FS.doc(a);
  return c === undefined ? FS.doc(FS.collection(a, b)) : FS.doc(a, b, c);
}

export function query(base, ...constraints) {
  return isDocs(base) ? D.queryRef(base, constraints) : FS.query(base, ...constraints.map(toFsConstraint));
}

/* ---------------- reads ---------------- */
export const getDoc = (ref) => (isDocs(ref) ? D.getDoc(ref) : FS.getDoc(ref));
export const getDocs = (q) => (isDocs(q) ? D.getDocs(q) : FS.getDocs(q));
export const onSnapshot = (target, next, error) => (isDocs(target) ? D.onSnapshot(target, next, error) : FS.onSnapshot(target, next, error));

/* ---------------- writes ---------------- */
export const setDoc = (ref, data) => (isDocs(ref) ? D.setDoc(ref, data) : FS.setDoc(ref, toFs(data)));
export const updateDoc = (ref, data) => (isDocs(ref) ? D.updateDoc(ref, data) : FS.updateDoc(ref, toFs(data)));
export const deleteDoc = (ref) => (isDocs(ref) ? D.deleteDoc(ref) : FS.deleteDoc(ref));
export const addDoc = (col, data) => (isDocs(col) ? D.addDoc(col, data) : FS.addDoc(col, toFs(data)));

export function writeBatch(database) {
  if (isDocs(database)) return D.writeBatch(database);
  const b = FS.writeBatch(database);
  const w = {
    set: (ref, data) => (b.set(ref, toFs(data)), w),
    update: (ref, data) => (b.update(ref, toFs(data)), w),
    delete: (ref) => (b.delete(ref), w),
    commit: () => b.commit(),
  };
  return w;
}

/** All reads first, then writes — same rule as Firestore transactions. */
export function runTransaction(database, fn) {
  if (isDocs(database)) return D.runTransaction(database, fn);
  return FS.runTransaction(database, (t) => {
    const tx = {
      get: (ref) => t.get(ref),
      set: (ref, data) => (t.set(ref, toFs(data)), tx),
      update: (ref, data) => (t.update(ref, toFs(data)), tx),
      delete: (ref) => (t.delete(ref), tx),
    };
    return fn(tx);
  });
}

/** Maximum writes per batch for a database (Firestore allows 500; keep requests small for Sheets). */
export const batchSize = (database) => (isDocs(database) ? (database.kind === 'sheets' ? 150 : 300) : 400);

// How values travel to Supabase / Google Sheets (which store plain JSON).
// Dates become { "__ts": "ISO" }; "server time" is a sentinel the server fills in.

export class Timestamp {
  constructor(ms) {
    this._ms = ms;
  }
  static fromDate(d) {
    return new Timestamp(d.getTime());
  }
  static now() {
    return new Timestamp(Date.now());
  }
  toDate() {
    return new Date(this._ms);
  }
  toMillis() {
    return this._ms;
  }
}

export const SERVER_TIME = { __serverTimestamp: true };
export const isServerTime = (v) => !!v && typeof v === 'object' && v.__serverTimestamp === true;
const hasToDate = (v) => !!v && typeof v === 'object' && typeof v.toDate === 'function';

/** JS value → JSON for the server. */
export function encode(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (v instanceof Date) return { __ts: v.toISOString() };
  if (hasToDate(v)) return { __ts: v.toDate().toISOString() };
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : encode(x)));
  if (typeof v === 'object') {
    if (isServerTime(v)) return SERVER_TIME;
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      const e = encode(x);
      if (e !== undefined) o[k] = e;
    }
    return o;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}

/** JSON from the server → JS value (dates come back as Timestamp, like Firestore). */
export function decode(v) {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && typeof v.__ts === 'string') return new Timestamp(Date.parse(v.__ts));
    const o = {};
    for (const k of keys) o[k] = decode(v[k]);
    return o;
  }
  return v;
}

/** Applies an update patch locally (top-level merge), used to predict results inside transactions. */
export const mergePatch = (base, patch) => ({ ...(base || {}), ...patch });

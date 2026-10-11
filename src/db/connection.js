// Which database the canteen uses. The choice lives in Firestore at settings/connection
// (readable by anyone, so every device knows it before sign-in; only owner accounts
// can change it). Firebase is always used for sign-in.

import { doc as fsDoc, setDoc as fsSetDoc, serverTimestamp as fsServerTimestamp } from 'firebase/firestore';
import { firebaseConfig } from '../firebase/config';
import { homeDb, isConfigured } from '../firebase';

const CACHE_KEY = 'canteen.connection';

export const isSupabaseUrl = (u) => /^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(String(u || '').trim());
export const isSheetsUrl = (u) => /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec\/?$/.test(String(u || '').trim());

function jwtPayload(token) {
  try {
    const p = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(p + '==='.slice((p.length + 3) % 4)));
  } catch {
    return null;
  }
}

/** '' when the key is safe for a website, otherwise what's wrong. */
export function supabaseKeyProblem(key) {
  const k = String(key || '').trim();
  if (!k) return 'Paste the publishable key (sb_publishable_…) or the anon public key.';
  if (/^sb_secret_/.test(k)) return 'That is the SECRET key. It bypasses all rules and must never be used in a website. Use the publishable key.';
  if (/^sb_publishable_/.test(k)) return '';
  const p = k.startsWith('eyJ') ? jwtPayload(k) : null;
  if (p?.role === 'service_role') return 'That is the service_role key. It bypasses all rules and must never be used in a website. Use the anon public key.';
  if (p?.role === 'anon') return '';
  return 'This does not look like a Supabase key. Copy the publishable key from Project Settings → API Keys.';
}

/** A valid choice; anything incomplete falls back to Firestore. */
export function normalizeChoice(c = {}) {
  const supabaseUrl = String(c.supabaseUrl || '').trim().replace(/\/+$/, '');
  const supabaseKey = String(c.supabaseKey || '').trim();
  const sheetsUrl = String(c.sheetsUrl || '').trim();
  const backend =
    c.backend === 'supabase' && isSupabaseUrl(supabaseUrl) && !supabaseKeyProblem(supabaseKey) ? 'supabase'
      : c.backend === 'sheets' && isSheetsUrl(sheetsUrl) ? 'sheets'
        : 'firestore';
  return {
    backend,
    supabaseUrl: backend === 'supabase' ? supabaseUrl : '',
    supabaseKey: backend === 'supabase' ? supabaseKey : '',
    sheetsUrl: backend === 'sheets' ? sheetsUrl : '',
    ownerUids: Array.isArray(c.ownerUids) ? c.ownerUids : [],
    updatedBy: c.updatedBy || '',
    updatedAt: c.updatedAt || '',
  };
}

const readCache = () => {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
  } catch {
    return null;
  }
};
const writeCache = (c) => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
};

/** Reads settings/connection through Firestore's public REST address (no sign-in needed). */
export async function loadChoice() {
  if (!isConfigured) return normalizeChoice();
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseConfig.projectId)}/databases/(default)/documents/settings/connection?key=${encodeURIComponent(firebaseConfig.apiKey)}`;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (res.status === 404) {
      const c = normalizeChoice();
      writeCache(c);
      return c;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const f = (await res.json()).fields || {};
    const str = (k) => f[k]?.stringValue || '';
    const c = normalizeChoice({
      backend: str('backend'),
      supabaseUrl: str('supabaseUrl'),
      supabaseKey: str('supabaseKey'),
      sheetsUrl: str('sheetsUrl'),
      ownerUids: (f.ownerUids?.arrayValue?.values || []).map((v) => v.stringValue),
      updatedBy: str('updatedBy'),
      updatedAt: f.updatedAt?.timestampValue || '',
    });
    writeCache(c);
    return c;
  } catch (e) {
    console.warn('Database choice unavailable, using the last known one:', e.message);
    return normalizeChoice(readCache() || {});
  }
}

/** Saves the canteen's database choice (owner accounts only — see firestore.rules). */
export async function saveChoice(choice, { uid, byName }) {
  const c = normalizeChoice(choice);
  const ownerUids = [...new Set([...(c.ownerUids || []), uid].filter(Boolean))];
  await fsSetDoc(fsDoc(homeDb, 'settings', 'connection'), {
    backend: c.backend,
    supabaseUrl: c.supabaseUrl,
    supabaseKey: c.supabaseKey,
    sheetsUrl: c.sheetsUrl,
    ownerUids,
    updatedBy: byName || '',
    updatedAt: fsServerTimestamp(),
  });
  writeCache({ ...c, ownerUids });
}

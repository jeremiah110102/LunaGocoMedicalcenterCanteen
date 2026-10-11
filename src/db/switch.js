// Testing a database and moving the canteen onto it.
import { auth } from '../firebase';
import { BACKENDS, backend as currentBackend, connection, db, makeDb, collection, doc, getDoc, writeBatch, addDoc, serverTimestamp } from './index';
import { send } from './docs';
import { isSheetsUrl, isSupabaseUrl, normalizeChoice, saveChoice, supabaseKeyProblem } from './connection';
import { readAllCollections, writeCollections } from '../services/backup';

/** What's wrong with the typed details, or ''. */
export function choiceProblem(c) {
  if (c.backend === 'supabase') {
    if (!isSupabaseUrl(c.supabaseUrl)) return 'Enter the Supabase Project URL, like https://abcdefgh.supabase.co';
    return supabaseKeyProblem(c.supabaseKey);
  }
  if (c.backend === 'sheets' && !isSheetsUrl(c.sheetsUrl)) {
    return 'Enter the Apps Script Web app URL: it starts with https://script.google.com/macros/s/ and ends with /exec';
  }
  return '';
}

export const sameDatabase = (a, b) => {
  const x = normalizeChoice(a);
  const y = normalizeChoice(b);
  return x.backend === y.backend && x.supabaseUrl === y.supabaseUrl && x.sheetsUrl === y.sheetsUrl;
};

/** Returns { ok, level: 'ok' | 'warning' | 'error', message }. */
export async function testDatabase(choice) {
  const problem = choiceProblem(choice);
  if (problem) return { ok: false, level: 'error', message: problem };
  const c = normalizeChoice(choice);
  const uid = auth.currentUser?.uid;
  const target = makeDb(c);
  const where = c.backend === 'supabase' ? c.supabaseUrl.replace(/^https:\/\//, '') : c.backend === 'sheets' ? 'your Google Sheet' : 'Firestore';
  try {
    if (c.backend !== 'firestore') {
      const ping = await send(target, { action: 'ping' });
      if (ping.app !== 'campus-canteen-pos') {
        return { ok: false, level: 'error', message: c.backend === 'supabase' ? 'This Supabase project is not set up for the canteen. Run supabase/schema.sql in its SQL Editor.' : 'This URL is not the canteen’s Database.gs script.' };
      }
      if (!ping.signedIn) {
        return {
          ok: false,
          level: 'error',
          message: c.backend === 'supabase'
            ? 'Supabase did not recognise your Firebase sign-in. In Supabase open Authentication → Third-party Auth → Add provider → Firebase and enter your Firebase Project ID.'
            : 'The script could not verify your Firebase sign-in. Check FIREBASE_API_KEY at the top of Database.gs, save, and deploy a new version.',
        };
      }
    }
    const setup = await getDoc(doc(target, 'settings', 'setup'));
    if (setup.exists() && setup.data().ownerUid !== uid) {
      return { ok: false, level: 'error', message: `${BACKENDS[c.backend]} (${where}) already belongs to a different owner account. Use an empty database, or sign in with that owner.` };
    }
    return {
      ok: true,
      level: setup.exists() ? 'warning' : 'ok',
      message: setup.exists()
        ? `Connected to ${where}. It already has canteen data owned by you; copying will update matching records.`
        : `Connected to ${where}. It is empty and ready.`,
    };
  } catch (e) {
    return { ok: false, level: 'error', message: e.message || String(e) };
  }
}

/**
 * Moves the canteen to another database.
 * source: 'current' (copy everything now in use) | 'file' (parsed Excel backup) | 'empty'
 */
export async function switchDatabase({ choice, source, parsed, account, profile, onStep = () => {}, onProgress }) {
  const c = normalizeChoice(choice);
  const user = auth.currentUser;
  if (!user || account?.role !== 'admin') throw new Error('Only the owner account can change the database.');
  if (sameDatabase(c, connection)) throw new Error(`The canteen already uses this ${BACKENDS[c.backend]} database.`);
  const target = makeDb(c);

  onStep('Checking the new database…');
  const setupRef = doc(target, 'settings', 'setup');
  const setup = await getDoc(setupRef);
  if (setup.exists() && setup.data().ownerUid !== user.uid) throw new Error('That database belongs to a different owner account.');
  if (!setup.exists()) {
    // Make this account the owner there, exactly like the very first sign-in.
    const b = writeBatch(target);
    b.set(doc(target, 'users', user.uid), {
      email: user.email || '',
      displayName: user.displayName || user.email || '',
      role: 'admin',
      active: true,
      createdAt: serverTimestamp(),
    });
    b.set(setupRef, { ownerUid: user.uid, createdAt: serverTimestamp() });
    await b.commit();
  }

  let counts = {};
  if (source !== 'empty') {
    onStep(source === 'file' ? 'Copying the backup file into the new database…' : 'Reading all current data…');
    const collections = source === 'file' ? parsed.collections : await readAllCollections(db);
    counts = Object.fromEntries(Object.entries(collections).map(([k, v]) => [k, v.length]));
    onStep('Copying data into the new database…');
    await writeCollections(target, collections, { skipUid: user.uid, onProgress });
  }

  onStep('Saving the new database choice…');
  await saveChoice({ ...c, ownerUids: connection.ownerUids }, { uid: user.uid, byName: profile?.displayName || user.email });

  await addDoc(collection(target, 'auditLogs'), {
    action: 'database.switch',
    details: { from: currentBackend, to: c.backend, source, counts },
    actorId: profile?.id || '',
    actorName: profile?.displayName || '',
    actorRole: profile?.role || '',
    accountUid: user.uid,
    createdAt: serverTimestamp(),
  }).catch(() => {});
  onStep('Done. Restarting on the new database…');
}


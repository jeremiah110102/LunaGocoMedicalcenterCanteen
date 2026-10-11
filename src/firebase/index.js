import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';
import { firebaseConfig } from './config';

export const isConfigured = !String(firebaseConfig.apiKey).startsWith('YOUR_');

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
/** Firestore of this Firebase project. Holds the database choice (settings/connection),
 *  and all data when Firestore is the selected database. Use `db` from src/db for data. */
export const homeDb = (() => {
  // Keeps a copy of Firestore data on this device so screens still load offline.
  try {
    return initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch {
    return getFirestore(app);
  }
})();
export const googleProvider = new GoogleAuthProvider();

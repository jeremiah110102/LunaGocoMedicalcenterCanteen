import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updateProfile,
  sendPasswordResetEmail,
} from 'firebase/auth';
import { db, collection, doc, getDoc, onSnapshot, serverTimestamp, setDoc, updateDoc, writeBatch } from '../db';
import { auth, googleProvider } from '../firebase';
import { APP } from '../config/app';
import { lockoutLeft, pinFields, registerFailure, verifyPin } from '../lib/pin';
import { logAudit } from '../lib/audit';

/*
  Two layers of sign-in:
  1. ACCOUNT  — a Firebase Auth login that unlocks the device (users/{uid}).
                The very first account ever created becomes the owner ("admin" account).
                Later accounts start as "pending" until the owner approves them.
  2. OPERATOR — the staff member using the counter right now (staff/{id}),
                chosen by tapping a name and entering a PIN. Roles come from here.
*/

const AuthContext = createContext(null);
const OP_KEY = 'canteen.operator';
const GUARD_KEY = 'canteen.pinGuard';
const STAFF_KEY = 'canteen.staffCache'; // lets staff unlock with their PIN while offline

const readJSON = (k, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? fallback;
  } catch {
    return fallback;
  }
};
const writeJSON = (k, v) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

/** Creates the user's account doc. First account ever → owner admin; otherwise pending. */
async function createAccountDoc(u) {
  const ref = doc(db, 'users', u.uid);
  const base = { email: u.email || '', displayName: u.displayName || u.email || '', active: true, createdAt: serverTimestamp() };
  const setupRef = doc(db, 'settings', 'setup');
  const setup = await getDoc(setupRef);
  if (!setup.exists()) {
    try {
      const b = writeBatch(db);
      b.set(ref, { ...base, role: 'admin' });
      b.set(setupRef, { ownerUid: u.uid, createdAt: serverTimestamp() });
      await b.commit();
      return;
    } catch {
      // Someone else finished setup first — fall through to pending.
    }
  }
  await setDoc(ref, { ...base, role: 'pending' });
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [staff, setStaff] = useState(() => {
    const cached = readJSON(STAFF_KEY, null);
    return cached ? { docs: cached, loading: false } : { docs: [], loading: true };
  });
  const [operatorId, setOperatorId] = useState(() => readJSON(OP_KEY, null));
  const creating = useRef(false);

  /* ---- Firebase account ---- */
  useEffect(() => {
    let stopAccount = () => {};
    const stopAuth = onAuthStateChanged(auth, (u) => {
      stopAccount();
      setUser(u);
      setError(null);
      if (!u) {
        setAccount(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      const cachedAccount = readJSON(`canteen.account.${u.uid}`, null);
      if (cachedAccount) {
        setAccount(cachedAccount);
        setLoading(false);
      }
      stopAccount = onSnapshot(
        doc(db, 'users', u.uid),
        async (snap) => {
          if (!snap.exists()) {
            if (creating.current) return;
            creating.current = true;
            try {
              await createAccountDoc(u);
            } catch (e) {
              setError(e);
              setLoading(false);
            } finally {
              creating.current = false;
            }
            return;
          }
          const acct = { id: snap.id, ...snap.data() };
          setAccount(acct);
          writeJSON(`canteen.account.${u.uid}`, { id: acct.id, email: acct.email, displayName: acct.displayName, role: acct.role, active: acct.active });
          setLoading(false);
        },
        (e) => {
          // Offline: keep using the last known account on this device
          if (!readJSON(`canteen.account.${u.uid}`, null)) setError(e);
          setLoading(false);
        },
      );
    });
    return () => {
      stopAccount();
      stopAuth();
    };
  }, []);

  const approved = !!account && account.active !== false && ['admin', 'device'].includes(account.role);

  /* ---- Staff list (for the PIN screen and the current operator) ---- */
  useEffect(() => {
    if (!approved) {
      setStaff({ docs: [], loading: false });
      return undefined;
    }
    setStaff((s) => ({ ...s, loading: !s.docs.length }));
    return onSnapshot(
      collection(db, 'staff'),
      (snap) => {
        const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setStaff({ docs, loading: false });
        writeJSON(STAFF_KEY, docs.map(({ createdAt, updatedAt, pinUpdatedAt, ...x }) => x));
      },
      (e) => {
        const cached = readJSON(STAFF_KEY, null);
        if (cached) setStaff({ docs: cached, loading: false });
        else {
          setError(e);
          setStaff({ docs: [], loading: false });
        }
      },
    );
  }, [approved]);

  const operator = staff.docs.find((s) => s.id === operatorId && s.active !== false) || null;

  // Forget an operator who was disabled or deleted.
  useEffect(() => {
    if (!staff.loading && operatorId && !operator) {
      setOperatorId(null);
      writeJSON(OP_KEY, null);
    }
  }, [staff.loading, operatorId, operator]);

  const profile = useMemo(
    () => (operator ? { id: operator.id, role: operator.role, displayName: operator.name, email: '', active: true, accountUid: user?.uid } : null),
    [operator, user?.uid],
  );

  const needsAdminSetup = approved && !staff.loading && !staff.docs.some((s) => s.role === 'admin' && s.active !== false);

  /* ---- PIN session ---- */
  const lock = useCallback(() => {
    setOperatorId(null);
    writeJSON(OP_KEY, null);
  }, []);

  const unlock = useCallback(async (staffId, pin) => {
    const s = staff.docs.find((x) => x.id === staffId);
    if (!s || s.active === false) throw new Error('This staff member is not active.');
    const guards = readJSON(GUARD_KEY, {});
    const wait = lockoutLeft(guards[staffId]);
    if (wait) throw new Error(`Too many wrong PINs. Try again in ${wait}s.`);
    if (!(await verifyPin(pin, s))) {
      guards[staffId] = registerFailure(guards[staffId]);
      writeJSON(GUARD_KEY, guards);
      const left = lockoutLeft(guards[staffId]);
      throw new Error(left ? `Too many wrong PINs. Locked for ${left}s.` : 'Wrong PIN.');
    }
    delete guards[staffId];
    writeJSON(GUARD_KEY, guards);
    setOperatorId(s.id);
    writeJSON(OP_KEY, s.id);
    logAudit({ id: s.id, displayName: s.name, role: s.role }, 'staff.unlock', {});
  }, [staff.docs]);

  const changeOwnPin = useCallback(async (currentPin, nextPin) => {
    if (!operator) throw new Error('Not signed in.');
    if (!(await verifyPin(currentPin, operator))) throw new Error('Current PIN is wrong.');
    await updateDoc(doc(db, 'staff', operator.id), { ...(await pinFields(nextPin)), pinUpdatedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    await logAudit(profile, 'staff.pinChange', { staffId: operator.id, name: operator.name, by: 'self' });
  }, [operator, profile]);

  /** First-run: the owner account creates the first admin staff profile and is unlocked as it. */
  const createFirstAdmin = useCallback(async (name, pin) => {
    const ref = doc(collection(db, 'staff'));
    await setDoc(ref, {
      name: name.trim(),
      role: 'admin',
      active: true,
      ...(await pinFields(pin)),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    setOperatorId(ref.id);
    writeJSON(OP_KEY, ref.id);
    await logAudit({ id: ref.id, displayName: name.trim(), role: 'admin' }, 'staff.setupAdmin', { name: name.trim() });
  }, []);

  /* ---- auto-lock when idle ---- */
  useEffect(() => {
    const mins = Number(APP.autoLockMinutes) || 0;
    if (!operator || mins <= 0) return undefined;
    let t;
    const reset = () => {
      clearTimeout(t);
      t = setTimeout(lock, mins * 60_000);
    };
    const events = ['pointerdown', 'keydown'];
    events.forEach((e) => window.addEventListener(e, reset));
    reset();
    return () => {
      clearTimeout(t);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [operator, lock]);

  const value = {
    user,
    account,
    approved,
    profile,
    staff: staff.docs,
    staffLoading: staff.loading,
    needsAdminSetup,
    loading: loading || (approved && staff.loading),
    error,
    unlock,
    lock,
    changeOwnPin,
    createFirstAdmin,
    loginEmail: (email, password) => signInWithEmailAndPassword(auth, email, password),
    register: async (name, email, password) => {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      if (name) await updateProfile(cred.user, { displayName: name });
      return cred;
    },
    loginGoogle: () => signInWithPopup(auth, googleProvider),
    resetPassword: (email) => sendPasswordResetEmail(auth, email),
    logout: async () => {
      lock();
      writeJSON(STAFF_KEY, null);
      if (user) writeJSON(`canteen.account.${user.uid}`, null);
      await signOut(auth);
    },
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

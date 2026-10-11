import { useEffect, useState } from 'react';
import { onSnapshot } from '../db';

const CACHE = 'canteen.cache.';
const readCache = (key) => {
  try {
    return key ? JSON.parse(localStorage.getItem(CACHE + key) || 'null') : null;
  } catch {
    return null;
  }
};
const writeCache = (key, docs) => {
  try {
    if (key) localStorage.setItem(CACHE + key, JSON.stringify(docs));
  } catch {
    /* storage full — the live data still works */
  }
};

/**
 * Live query. `makeQuery` returns a query/collection ref (or null to skip).
 * With { cacheKey }, the last result is kept on this device and shown when offline
 * (used by the cashier screen so it keeps working without internet).
 */
export function useCollection(makeQuery, deps = [], { cacheKey } = {}) {
  const [state, setState] = useState(() => {
    const cached = readCache(cacheKey);
    return { docs: cached || [], loading: !cached, error: null, fromCache: !!cached };
  });
  useEffect(() => {
    const q = makeQuery();
    if (!q) {
      setState({ docs: [], loading: false, error: null, fromCache: false });
      return undefined;
    }
    setState((s) => ({ ...s, loading: !s.docs.length }));
    return onSnapshot(
      q,
      (snap) => {
        const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setState({ docs, loading: false, error: null, fromCache: false });
        writeCache(cacheKey, docs);
      },
      (error) => {
        console.error(error);
        const cached = readCache(cacheKey);
        setState(cached ? { docs: cached, loading: false, error: null, fromCache: true } : { docs: [], loading: false, error, fromCache: false });
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export const byId = (docs) => Object.fromEntries(docs.map((d) => [d.id, d]));

import { db, collection, query, where } from '../db';
import { useAuth } from '../context/AuthContext';
import { useCollection } from './useCollection';

/** The signed-in staff member's open shift (live), or null. */
export function useShift() {
  const { profile } = useAuth();
  const list = useCollection(() => (profile ? query(collection(db, 'shifts'), where('staffId', '==', profile.id)) : null), [profile?.id], { cacheKey: profile ? `shifts.${profile.id}` : undefined });
  const shift = list.docs.find((s) => s.status === 'open') || null;
  return { shift, loading: list.loading, error: list.error };
}

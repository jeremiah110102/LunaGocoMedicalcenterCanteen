import { db, addDoc, collection, serverTimestamp } from '../db';
import { auth } from '../firebase';

/** Records a sensitive action. Failures are logged but never block the user's action. */
export async function logAudit(profile, action, details = {}) {
  try {
    await addDoc(collection(db, 'auditLogs'), {
      action,
      details,
      actorId: profile.id,
      actorName: profile.displayName || profile.email || '',
      actorRole: profile.role,
      accountUid: auth.currentUser?.uid || '',
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    console.error('Audit log failed', e);
  }
}

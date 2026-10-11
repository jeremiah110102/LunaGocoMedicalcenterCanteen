// Staff PIN helpers. PINs are never stored, only a salted PBKDF2 hash.

export const PIN_MIN = 4;
export const PIN_MAX = 6;
export const MAX_ATTEMPTS = 5;
export const LOCKOUT_SECONDS = 60;

const ITERATIONS = 100_000;
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Returns an error message, or '' when the PIN is acceptable. */
export function pinProblem(pin) {
  const p = String(pin ?? '');
  if (!/^\d+$/.test(p)) return 'PIN must contain digits only.';
  if (p.length < PIN_MIN || p.length > PIN_MAX) return `PIN must be ${PIN_MIN}–${PIN_MAX} digits.`;
  if (/^(\d)\1+$/.test(p)) return 'PIN can’t be the same digit repeated.';
  if ('0123456789'.includes(p) || '9876543210'.includes(p)) return 'PIN can’t be a simple sequence like 1234.';
  return '';
}

export function newSalt() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return toHex(b);
}

export async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: ITERATIONS }, key, 256);
  return toHex(bits);
}

/** Fields to store on a staff document for a new PIN. */
export async function pinFields(pin) {
  const pinSalt = newSalt();
  return { pinSalt, pinHash: await hashPin(pin, pinSalt) };
}

export async function verifyPin(pin, staff) {
  if (!staff?.pinHash || !staff?.pinSalt) return false;
  const h = await hashPin(pin, staff.pinSalt);
  // constant-time-ish compare
  let diff = h.length ^ staff.pinHash.length;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ staff.pinHash.charCodeAt(i % staff.pinHash.length);
  return diff === 0;
}

/* ---- wrong-PIN lockout (per staff member, per device) ---- */

/** state: { fails, until } ; returns updated state after a failed attempt. */
export function registerFailure(state = { fails: 0, until: 0 }, now = Date.now()) {
  const fails = (state.until && now >= state.until ? 0 : state.fails) + 1;
  return fails >= MAX_ATTEMPTS ? { fails: 0, until: now + LOCKOUT_SECONDS * 1000 } : { fails, until: 0 };
}

/** Seconds remaining in a lockout, or 0. */
export const lockoutLeft = (state, now = Date.now()) => (state?.until > now ? Math.ceil((state.until - now) / 1000) : 0);

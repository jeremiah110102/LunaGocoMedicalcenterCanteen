// Sales made while the internet is down are kept on this device and sent later.
// Each queued sale keeps its saleId, so sending it twice can never record it twice.
import { computeTotals, round2, validatePayment } from '../lib/checkout';
import { processSale, SaleError } from './sales';

const KEY = 'canteen.offlineSales';
const SEQ = 'canteen.offlineSeq';
const EVENT = 'canteen-offline-queue';

const read = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
};
const write = (list) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full — nothing else we can do */
  }
  window.dispatchEvent(new Event(EVENT));
};

export const pendingSales = () => read();
export const onQueueChange = (fn) => {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
};

/** True when an error means "couldn't reach the database", not "the sale is invalid". */
export function isNetworkError(e) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (e instanceof SaleError) return false;
  return ['unavailable', 'deadline-exceeded', 'timeout'].includes(e?.code) || /network|failed to fetch|offline|reach/i.test(e?.message || '');
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'timeout' })), ms))]);

/**
 * Tries to record a sale online; if the database can't be reached, keeps it on the
 * device and returns a provisional sale for the receipt.
 */
export async function sellOrQueue(args) {
  try {
    return { ...(await withTimeout(processSale(args), 15000)), queued: false };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    // validate what we can without the database
    const totals = computeTotals(args.cart, args.discount);
    const pay = validatePayment({ method: args.method, total: totals.total, tendered: args.tendered, reference: args.reference, account: args.method === 'credit' ? { balance: 0, limit: Infinity } : null });
    if (!pay.ok) throw new SaleError(pay.error);
    let seq = 1;
    try {
      seq = Number(localStorage.getItem(SEQ) || 0) + 1;
      localStorage.setItem(SEQ, String(seq));
    } catch {
      /* ignore */
    }
    const offline = { at: new Date().toISOString(), tempNo: `OFF-${String(seq).padStart(4, '0')}` };
    const { profile, ...rest } = args;
    write([...read(), { ...rest, profile: { id: profile.id, displayName: profile.displayName, role: profile.role }, offline, attempts: 0 }]);
    return {
      queued: true,
      duplicate: false,
      sale: {
        id: args.saleId,
        offlineNo: offline.tempNo,
        offlineAt: offline.at,
        pendingSync: true,
        items: args.cart.map((l) => ({ ...l, lineTotal: round2(l.price * l.qty) })),
        ...totals,
        discountType: args.discount?.type,
        discountValue: Number(args.discount?.value) || 0,
        paymentMethod: args.method,
        tendered: args.method === 'cash' ? round2(Number(args.tendered)) : totals.total,
        change: pay.change,
        reference: args.reference || '',
        creditAccountName: args.accountName || '',
        cashierName: profile.displayName,
      },
    };
  }
}

let syncing = false;
/** Sends waiting sales. Returns { sent, failed, left }. */
export async function syncOfflineSales() {
  if (syncing) return { sent: 0, failed: 0, left: read().length };
  syncing = true;
  let sent = 0;
  let failed = 0;
  try {
    for (const item of read()) {
      try {
        await withTimeout(processSale({ ...item, offline: item.offline, allowOversell: true }), 20000);
        write(read().filter((x) => x.saleId !== item.saleId));
        sent++;
      } catch (e) {
        if (isNetworkError(e)) break; // still offline — try later
        failed++;
        write(read().map((x) => (x.saleId === item.saleId ? { ...x, attempts: (x.attempts || 0) + 1, lastError: e.message } : x)));
      }
    }
  } finally {
    syncing = false;
  }
  return { sent, failed, left: read().length };
}

/** Removes a queued sale that can never be sent (after a manager has dealt with it). */
export const discardQueued = (saleId) => write(read().filter((x) => x.saleId !== saleId));

/** Starts background syncing: when the connection returns, and every 30 seconds. */
export function startOfflineSync(onResult) {
  const run = () => {
    if (!read().length) return;
    syncOfflineSales().then((r) => r.sent && onResult?.(r)).catch(() => {});
  };
  window.addEventListener('online', run);
  const t = setInterval(run, 30000);
  setTimeout(run, 3000);
  return () => {
    window.removeEventListener('online', run);
    clearInterval(t);
  };
}

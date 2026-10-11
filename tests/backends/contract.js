// Shared contract tests: the same rules must hold for Supabase and Google Sheets.
import { describe, it, expect } from 'vitest';
import * as D from '../../src/db/docs.js';
import { SERVER_TIME } from '../../src/db/encoding.js';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
export const token = (uid, project = 'canteen-test') => `${b64({ alg: 'none' })}.${b64({ iss: `https://securetoken.google.com/${project}`, aud: project, sub: uid })}.sig`;
export let counter = { requests: 0 };
const ref = (db, col, id) => D.docRef(db, col, id);
const denied = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.code;
  }
  return 'allowed';
};

export function contract(name, makeDb) {
describe(`${name}: rules + docs.js client`, () => {
  const as = makeDb;
  const owner = () => as('OWNER');
  const other = () => as('OTHER');

  it('ping says who is signed in', async () => {
    expect((await D.send(owner(), { action: 'ping' })).uid).toBe('OWNER');
    expect((await D.send(as(null), { action: 'ping' })).signedIn).toBe(false);
    // token from a different Firebase project is ignored
    const forged = { ...as(null), listeners: new Set(), active: 0, waiting: [], getToken: async () => `${b64({})}.${b64({ iss: 'https://evil.example', aud: 'x', sub: 'OWNER' })}.s` };
    expect((await D.send(forged, { action: 'ping' })).signedIn).toBe(false);
  });

  it('first account becomes owner; a second one cannot', async () => {
    const db = owner();
    const b = D.writeBatch(db);
    b.set(ref(db, 'users', 'OWNER'), { email: 'o@x', displayName: 'O', role: 'admin', active: true, createdAt: SERVER_TIME });
    b.set(ref(db, 'settings', 'setup'), { ownerUid: 'OWNER', createdAt: SERVER_TIME });
    await b.commit();

    const db2 = other();
    const b2 = D.writeBatch(db2);
    b2.set(ref(db2, 'users', 'OTHER'), { email: 'x@x', role: 'admin', active: true });
    b2.set(ref(db2, 'settings', 'setup'), { ownerUid: 'OTHER' });
    expect(await denied(b2.commit())).toBe('permission-denied');
    // can only join as pending, and can't sneak in extra fields
    expect(await denied(D.setDoc(ref(db2, 'users', 'OTHER'), { email: 'x@x', role: 'pending', active: true, hack: 1 }))).toBe('permission-denied');
    await D.setDoc(ref(db2, 'users', 'OTHER'), { email: 'x@x', displayName: 'X', role: 'pending', active: true, createdAt: SERVER_TIME });
  });

  it('pending accounts see nothing; owner approves; nobody becomes owner', async () => {
    expect(await denied(D.getDocs(D.collectionRef(other(), 'products')).then((s) => (s.size ? 'allowed' : Promise.reject({ code: 'empty' }))))).not.toBe('allowed');
    expect(await denied(D.setDoc(ref(other(), 'categories', 'c1'), { name: 'X' }))).toBe('permission-denied');
    expect(await denied(D.updateDoc(ref(other(), 'users', 'OTHER'), { role: 'device' }))).toBe('permission-denied');
    expect(await denied(D.updateDoc(ref(owner(), 'users', 'OTHER'), { role: 'admin' }))).toBe('permission-denied');
    await D.updateDoc(ref(owner(), 'users', 'OTHER'), { role: 'device' });
    await D.setDoc(ref(other(), 'categories', 'c1'), { name: 'Drinks' });
    // device can't read the accounts list, only itself
    const users = await D.getDocs(D.collectionRef(other(), 'users'));
    expect(users.docs.map((d) => d.id)).toEqual(['OTHER']);
  });

  it('validates staff, products and stock', async () => {
    const db = other();
    expect(await denied(D.setDoc(ref(db, 'staff', 's1'), { name: 'Ana', role: 'admin' }))).toBe('permission-denied');
    await D.setDoc(ref(db, 'staff', 's1'), { name: 'Ana', role: 'admin', pinHash: 'h', pinSalt: 's', active: true });
    expect(await denied(D.setDoc(ref(db, 'products', 'p1'), { name: 'Coke', price: -1 }))).toBe('permission-denied');
    await D.setDoc(ref(db, 'products', 'p1'), { name: 'Coke', price: 25, stock: 10, trackStock: true, archived: false, createdAt: SERVER_TIME });
    expect(await denied(D.updateDoc(ref(db, 'products', 'p1'), { stock: 'lots' }))).toBe('permission-denied');
    const p = await D.getDoc(ref(db, 'products', 'p1'));
    expect(p.data().createdAt.toDate()).toBeInstanceOf(Date); // server time came back as a timestamp
  });

  it('transactions retry when two cashiers sell at once', async () => {
    const sell = (db) =>
      D.runTransaction(db, async (tx) => {
        const [c, p] = await Promise.all([tx.get(ref(db, 'counters', 'sales')), tx.get(ref(db, 'products', 'p1'))]);
        const next = c.exists() ? c.data().next + 1 : 1;
        if (c.exists()) tx.update(ref(db, 'counters', 'sales'), { next });
        else tx.set(ref(db, 'counters', 'sales'), { next });
        tx.update(ref(db, 'products', 'p1'), { stock: p.data().stock - 1 });
        tx.set(ref(db, 'sales', `sale-${next}`), { items: [{ q: 1 }], total: 25, paymentMethod: 'cash', cashierId: 's1', accountUid: 'OTHER', createdAt: SERVER_TIME });
        return next;
      });
    const before = counter.requests;
    const results = await Promise.all([sell(other()), sell(other()), sell(owner()), sell(other())]);
    expect([...results].sort()).toEqual([1, 2, 3, 4]);
    expect((await D.getDoc(ref(other(), 'products', 'p1'))).data().stock).toBe(6);
    expect((await D.getDoc(ref(other(), 'counters', 'sales'))).data().next).toBe(4);
    expect(counter.requests - before).toBeLessThan(40); // reads in one Promise.all travel together
  });

  it('counter can only go up by one; sales cannot be edited except by the owner', async () => {
    expect(await denied(D.updateDoc(ref(other(), 'counters', 'sales'), { next: 99 }))).toBe('permission-denied');
    expect(await denied(D.updateDoc(ref(other(), 'sales', 'sale-1'), { total: 0 }))).toBe('permission-denied');
    expect(await denied(D.deleteDoc(ref(other(), 'sales', 'sale-1')))).toBe('permission-denied');
    expect(await denied(D.setDoc(ref(other(), 'sales', 'x'), { items: [{}], total: 1, paymentMethod: 'cash', cashierId: 's1', accountUid: 'SOMEONE' }))).toBe('permission-denied');
    await D.updateDoc(ref(owner(), 'sales', 'sale-1'), { note: 'restored' }); // restore path
    // devices may only record refund amounts on a sale, never more than its total
    await D.updateDoc(ref(other(), 'sales', 'sale-2'), { refundedTotal: 10, refundStatus: 'partial', refundedQty: { 0: 1 } });
    expect(await denied(D.updateDoc(ref(other(), 'sales', 'sale-2'), { refundedTotal: 26 }))).toBe('permission-denied');
    expect(await denied(D.updateDoc(ref(other(), 'sales', 'sale-2'), { refundedTotal: 10, total: 5 }))).toBe('permission-denied');
    // refunds need an approver and this device's account
    expect(await denied(D.setDoc(ref(other(), 'refunds', 'r1'), { lines: [{}], amount: 5, accountUid: 'OTHER' }))).toBe('permission-denied');
    await D.setDoc(ref(other(), 'refunds', 'r1'), { lines: [{}], amount: 5, approvedById: 's1', accountUid: 'OTHER' });
    expect(await denied(D.updateDoc(ref(other(), 'refunds', 'r1'), { amount: 1 }))).toBe('permission-denied');
    // deliveries: only payment fields can change
    await D.setDoc(ref(other(), 'deliveries', 'd1'), { items: [{}], total: 100, paidAmount: 0 });
    await D.updateDoc(ref(other(), 'deliveries', 'd1'), { paidAmount: 50, paymentStatus: 'partial' });
    expect(await denied(D.updateDoc(ref(other(), 'deliveries', 'd1'), { total: 1 }))).toBe('permission-denied');
    expect(await denied(D.setDoc(ref(other(), 'expenses', 'e1'), { amount: 0 }))).toBe('permission-denied');
    expect(await denied(D.deleteDoc(ref(other(), 'shifts', 'none')))).not.toBe('permission-denied'); // deleting nothing is a no-op
  });

  it('queries filter by date, sort and limit', async () => {
    const db = other();
    const q = D.queryRef(D.collectionRef(db, 'sales'), [
      { kind: 'where', field: 'createdAt', op: '>=', value: new Date(Date.now() - 60_000) },
      { kind: 'orderBy', field: 'createdAt', dir: 'desc' },
      { kind: 'orderBy', field: 'total', dir: 'asc' },
      { kind: 'limit', n: 3 },
    ]);
    const s = await D.getDocs(q);
    expect(s.size).toBe(3);
    const old = await D.getDocs(D.queryRef(D.collectionRef(db, 'sales'), [{ kind: 'where', field: 'createdAt', op: '<', value: new Date(Date.now() - 60_000) }]));
    expect(old.size).toBe(0);
    const eq = await D.getDocs(D.queryRef(D.collectionRef(db, 'products'), [{ kind: 'where', field: 'archived', op: '==', value: false }]));
    expect(eq.size).toBe(1);
  });

  it('credit balance and audit rules', async () => {
    const db = other();
    expect(await denied(D.setDoc(ref(db, 'creditAccounts', 'a1'), { name: 'A', balance: -5, limit: 100 }))).toBe('permission-denied');
    await D.setDoc(ref(db, 'creditAccounts', 'a1'), { name: 'A', balance: 0, limit: 100 });
    expect(await denied(D.setDoc(ref(db, 'auditLogs', 'l1'), { action: 'x', accountUid: 'OWNER' }))).toBe('permission-denied');
    await D.setDoc(ref(db, 'auditLogs', 'l1'), { action: 'x', accountUid: 'OTHER' });
    expect(await denied(D.updateDoc(ref(db, 'auditLogs', 'l1'), { action: 'y' }))).toBe('permission-denied');
  });
});
}

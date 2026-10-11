import { Link } from 'react-router-dom';
import { db, collection, orderBy, query, where } from '../db';
import { useAuth } from '../context/AuthContext';
import { useCollection } from '../hooks/useCollection';
import { BarList, Empty, ErrorNote, PageHead, Stat } from '../components/ui';
import { can } from '../lib/roles';
import { PAYMENT_METHODS } from '../lib/checkout';
import { fmtDateTime, peso, qty, startOfDay } from '../lib/format';
import { summarizeSales } from '../lib/reports';
import { stockItems, isLow } from './Inventory';
import { daysLeft, deliveryBalance, payableStatus } from '../lib/inventoryMath';
import { useShift } from '../hooks/useShift';
import { useOfflineQueue } from '../components/Scanning';

export default function Dashboard() {
  const { profile } = useAuth();
  const seesSales = can(profile, 'sales');
  const seesStock = can(profile, 'inventory');

  const sales = useCollection(
    () => (seesSales ? query(collection(db, 'sales'), where('createdAt', '>=', startOfDay()), orderBy('createdAt', 'desc')) : null),
    [seesSales],
  );
  const products = useCollection(() => collection(db, 'products'), []);
  const ingredients = useCollection(() => collection(db, 'ingredients'), []);
  const accounts = useCollection(() => (can(profile, 'credit') ? collection(db, 'creditAccounts') : null), []);

  const seesStockPages = can(profile, 'inventory');
  const isManager = ['admin', 'manager'].includes(profile.role);
  const batches = useCollection(() => (seesStockPages ? collection(db, 'batches') : null), [seesStockPages]);
  const deliveries = useCollection(() => (can(profile, 'purchasing') ? collection(db, 'deliveries') : null), []);
  const review = useCollection(() => (isManager ? query(collection(db, 'sales'), where('needsReview', '==', true)) : null), [isManager]);
  const openShifts = useCollection(() => (isManager ? query(collection(db, 'shifts'), where('status', '==', 'open')) : null), [isManager]);
  const { shift } = useShift();
  const { queue } = useOfflineQueue();
  const sum = summarizeSales(sales.docs);
  const expiring = batches.docs.filter((b) => b.status !== 'closed' && b.expiryDate && daysLeft(b.expiryDate) <= 3);
  const overdue = deliveries.docs.filter((d) => d.paidAmount !== undefined && payableStatus(d) === 'overdue');
  const oldShifts = openShifts.docs.filter((x) => x.openedAt?.toDate && Date.now() - x.openedAt.toDate().getTime() > 16 * 3600 * 1000);
  const attention = [
    can(profile, 'pos') && !shift && { text: 'You have no open shift.', to: '/shifts', kind: 'info' },
    queue.length > 0 && { text: `${queue.length} offline sale(s) waiting to be sent from this device.`, to: '/pos', kind: 'warn' },
    expiring.length > 0 && { text: `${expiring.length} batch(es) expire within 3 days.`, to: '/inventory', kind: 'warn' },
    overdue.length > 0 && { text: `${overdue.length} supplier delivery(ies) overdue: ${peso(overdue.reduce((t, d) => t + deliveryBalance(d), 0))}.`, to: '/purchasing', kind: 'bad' },
    review.docs.length > 0 && { text: `${review.docs.length} offline sale(s) need review (stock ran out or price changed).`, to: '/sales', kind: 'warn' },
    oldShifts.length > 0 && { text: `${oldShifts.length} shift(s) open for more than 16 hours: ${oldShifts.map((x) => x.staffName).join(', ')}.`, to: '/shifts', kind: 'warn' },
  ].filter(Boolean);
  const low = stockItems(products.docs, ingredients.docs).filter(isLow);
  const soldOut = products.docs.filter((p) => p.soldOut && !p.archived);
  const outstanding = accounts.docs.reduce((t, a) => t + (Number(a.balance) || 0), 0);
  const hour = new Date().getHours();

  return (
    <>
      <PageHead title={`Good ${hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'}, ${(profile.displayName || '').split(' ')[0] || 'there'}`} sub={new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}>
        {can(profile, 'pos') && <Link className="btn btn-primary" to="/pos">Open cashier</Link>}
      </PageHead>

      <ErrorNote error={sales.error || products.error} />

      <div className="stats">
        {seesSales && <Stat label="Sales today" value={peso(sum.total)} sub={`${sum.count} transactions`} kind="accent" />}
        {seesSales && <Stat label="Average sale" value={peso(sum.average)} />}
        <Stat label="Low stock" value={low.length} kind={low.length ? 'warn' : undefined} sub={soldOut.length ? `${soldOut.length} marked sold out` : undefined} />
        {can(profile, 'credit') && <Stat label="Credit outstanding" value={peso(outstanding)} />}
      </div>

      {attention.length > 0 && (
        <section className="card attention">
          <h2>Needs attention</h2>
          <ul className="plain-list">
            {attention.map((a) => (
              <li key={a.text} className="row-between">
                <span><span className={`dot dot-${a.kind}`} /> {a.text}</span>
                <Link className="link small" to={a.to}>Open →</Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid-dash">
        {seesSales && (
          <section className="card">
            <h2>Best sellers today</h2>
            <BarList rows={sum.products.slice(0, 8).map((p) => ({ label: p.name, value: p.qty, display: `${qty(p.qty)} · ${peso(p.revenue)}` }))} emptyText="No sales yet today." />
          </section>
        )}
        {seesSales && (
          <section className="card">
            <h2>Payment methods today</h2>
            <BarList rows={Object.entries(sum.byMethod).map(([k, v]) => ({ label: PAYMENT_METHODS[k] || k, value: v.total, display: `${peso(v.total)} (${v.count})` }))} emptyText="No sales yet today." />
          </section>
        )}
        <section className="card">
          <div className="row-between">
            <h2>Running low</h2>
            {seesStock && <Link to="/inventory" className="link">Inventory →</Link>}
          </div>
          {low.length ? (
            <ul className="plain-list">
              {low.slice(0, 10).map((i) => (
                <li key={`${i.itemType}${i.id}`} className="row-between">
                  <span>{i.name}</span>
                  <span className={Number(i.stock) <= 0 ? 'neg' : 'warn-text'}>{qty(i.stock)} {i.unit}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>Everything is stocked.</Empty>}
        </section>
        {seesSales && (
          <section className="card">
            <div className="row-between">
              <h2>Recent sales</h2>
              <Link to="/sales" className="link">All sales →</Link>
            </div>
            {sales.docs.length ? (
              <ul className="plain-list">
                {sales.docs.slice(0, 8).map((s) => (
                  <li key={s.id} className="row-between">
                    <span><span className="mono">{s.receiptNo}</span> <span className="muted small">{fmtDateTime(s.createdAt)}</span></span>
                    <strong>{peso(s.total)}</strong>
                  </li>
                ))}
              </ul>
            ) : <Empty>No sales yet today.</Empty>}
          </section>
        )}
      </div>
    </>
  );
}

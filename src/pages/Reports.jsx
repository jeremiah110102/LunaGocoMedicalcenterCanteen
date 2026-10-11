import { useState } from 'react';
import { db, collection, orderBy, query, where } from '../db';
import { useCollection } from '../hooks/useCollection';
import { BarList, Columns, Empty, ErrorNote, PageHead, Stat } from '../components/ui';
import { PAYMENT_METHODS } from '../lib/checkout';
import { dayKey, endOfDay, peso, qty, startOfDay } from '../lib/format';
import { profitAndLoss, summarizeMovements, summarizeSales } from '../lib/reports';
import { MovementTable, isLow, stockItems } from './Inventory';
import InventoryExport from '../components/InventoryExport';

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dayKey(d);
};

export default function Reports() {
  const [from, setFrom] = useState(daysAgo(6));
  const [to, setTo] = useState(dayKey(new Date()));
  const [tab, setTab] = useState('sales');

  const start = startOfDay(new Date(`${from}T00:00`));
  const end = endOfDay(new Date(`${to}T00:00`));
  const range = [where('createdAt', '>=', start), where('createdAt', '<=', end), orderBy('createdAt', 'desc')];

  const sales = useCollection(() => query(collection(db, 'sales'), ...range), [from, to]);
  const moves = useCollection(() => query(collection(db, 'stockMovements'), ...range), [from, to]);
  const refunds = useCollection(() => query(collection(db, 'refunds'), ...range), [from, to]);
  const expenses = useCollection(() => query(collection(db, 'expenses'), where('date', '>=', from), where('date', '<=', to)), [from, to]);
  const deliveries = useCollection(() => query(collection(db, 'deliveries'),
    where('receivedAt', '>=', start), where('receivedAt', '<=', end), orderBy('receivedAt', 'desc')), [from, to]);
  const products = useCollection(() => collection(db, 'products'), []);
  const ingredients = useCollection(() => collection(db, 'ingredients'), []);
  const accounts = useCollection(() => collection(db, 'creditAccounts'), []);

  const sum = summarizeSales(sales.docs, { from: start, to: end });
  const refundTotal = refunds.docs.reduce((t, r) => t + (Number(r.amount) || 0), 0);
  const costLookup = { product: Object.fromEntries(products.docs.map((p) => [p.id, Number(p.cost) || 0])), ingredient: Object.fromEntries(ingredients.docs.map((i) => [i.id, Number(i.cost) || 0])) };
  const pl = profitAndLoss({ sales: sales.docs, refunds: refunds.docs, movements: moves.docs, expenses: expenses.docs, costOf: (t, id) => costLookup[t]?.[id] || 0 });
  const usage = summarizeMovements(moves.docs);
  const items = stockItems(products.docs, ingredients.docs);
  const owing = accounts.docs.filter((a) => Number(a.balance) > 0).sort((a, b) => b.balance - a.balance);
  const preset = (n) => { setFrom(daysAgo(n)); setTo(dayKey(new Date())); };

  return (
    <>
      <PageHead title="Reports" sub={`${from} to ${to}`}>
        <button className="btn" onClick={() => window.print()}>Print</button>
      </PageHead>
      <div className="filters no-print">
        <label className="field-inline">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field-inline">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="chip" onClick={() => preset(0)}>Today</button>
        <button className="chip" onClick={() => preset(6)}>7 days</button>
        <button className="chip" onClick={() => preset(29)}>30 days</button>
      </div>
      <div className="tabs no-print">
        {[['sales', 'Sales'], ['profit', 'Profit'], ['inventory', 'Inventory'], ['credit', 'Credit']].map(([k, v]) => (
          <button key={k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{v}</button>
        ))}
      </div>
      <ErrorNote error={sales.error || moves.error} />

      {tab === 'sales' && (
        <>
          <div className="stats">
            <Stat label="Net sales" value={peso(sum.total - refundTotal)} kind="accent" sub={refundTotal ? `${peso(sum.total)} sold − ${peso(refundTotal)} refunded` : undefined} />
            <Stat label="Transactions" value={sum.count} sub={`Average ${peso(sum.average)}`} />
            <Stat label="Discounts given" value={peso(sum.discount)} />
            <Stat label="Gross profit" value={peso(sum.grossProfit)} sub={`Cost of goods ${peso(sum.cost)}`} />
          </div>
          <section className="card">
            <h2>Daily sales</h2>
            <Columns rows={sum.days.map((d) => ({ label: d.day, value: d.total, display: `${peso(d.total)} · ${d.count} sales` }))} />
          </section>
          <div className="grid-dash">
            <section className="card">
              <h2>Best-selling products</h2>
              <BarList rows={sum.products.slice(0, 12).map((p) => ({ label: p.name, value: p.qty, display: `${qty(p.qty)} sold · ${peso(p.revenue)}` }))} />
            </section>
            <section className="card">
              <h2>By payment method</h2>
              <BarList rows={Object.entries(sum.byMethod).map(([k, v]) => ({ label: PAYMENT_METHODS[k] || k, value: v.total, display: `${peso(v.total)} · ${v.count}` }))} />
              <h2 className="mt">By cashier</h2>
              <BarList rows={sum.cashiers.map((c) => ({ label: c.name, value: c.total, display: `${peso(c.total)} · ${c.count} sales` }))} />
            </section>
          </div>
        </>
      )}

      {tab === 'profit' && (
        <>
          <div className="stats">
            <Stat label="Net sales" value={peso(pl.netSales)} />
            <Stat label="Gross profit" value={peso(pl.grossProfit)} sub={pl.netSales ? `${Math.round((pl.grossProfit / pl.netSales) * 100)}% of sales` : undefined} />
            <Stat label="Net profit" value={peso(pl.netProfit)} kind={pl.netProfit < 0 ? 'warn' : 'accent'} sub={`${pl.margin}% margin`} />
          </div>
          <section className="card printable pl">
            <h2>Profit and loss · {from} to {to}</h2>
            <div className="sum-row"><span>Sales</span><span>{peso(pl.grossSales)}</span></div>
            <div className="sum-row"><span>− Refunds</span><span>{peso(pl.refundTotal)}</span></div>
            <div className="sum-row sum-strong"><span>Net sales</span><span>{peso(pl.netSales)}</span></div>
            <div className="sum-row"><span>− Cost of goods sold</span><span>{peso(pl.cogs)}</span></div>
            <div className="sum-row sum-strong"><span>Gross profit</span><span>{peso(pl.grossProfit)}</span></div>
            <div className="sum-row"><span>− Spoiled / expired / wasted stock</span><span>{peso(pl.waste)}</span></div>
            <div className="sum-row"><span>− Stock count differences</span><span>{peso(pl.countLoss)}</span></div>
            {Object.entries(pl.byCategory).map(([k, v]) => <div className="sum-row" key={k}><span>− {k}</span><span>{peso(v)}</span></div>)}
            {!Object.keys(pl.byCategory).length && <div className="sum-row"><span>− Expenses</span><span>{peso(0)}</span></div>}
            <div className="sum-row sum-total"><span>Net profit</span><span className={pl.netProfit < 0 ? 'neg' : ''}>{peso(pl.netProfit)}</span></div>
            <p className="muted small mt">Cost of goods uses each product’s cost at the time of sale. Waste and count differences use current item costs. Add expenses on the Expenses page.</p>
          </section>
        </>
      )}

      {tab === 'inventory' && (
        <>
          <div className="row-inline no-print"><strong>Export this period:</strong><InventoryExport from={from} to={to} /></div>
          <div className="stats">
            <Stat label="Tracked items" value={items.length} />
            <Stat label="Low or out" value={items.filter(isLow).length} kind="warn" />
            <Stat label="Deliveries received" value={peso(deliveries.docs.reduce((t, d) => t + (Number(d.total) || 0), 0))} sub={`${deliveries.docs.length} deliveries`} />
            <Stat label="Waste value (period)" value={peso(usage.reduce((t, u) => {
              const src = (u.itemType === 'product' ? products.docs : ingredients.docs).find((x) => x.id === u.itemId);
              return t + u.wasted * (Number(src?.cost) || 0);
            }, 0))} />
          </div>
          <section className="card table-wrap">
            <h2>Consumption and waste</h2>
            <table>
              <thead><tr><th>Item</th><th>Kind</th><th className="num">Used in sales</th><th className="num">Wasted</th><th className="num">Received</th><th className="num">Adjusted</th></tr></thead>
              <tbody>
                {usage.map((u) => (
                  <tr key={`${u.itemType}${u.itemId}`}>
                    <td>{u.name}</td><td>{u.itemType}</td>
                    <td className="num">{qty(u.used)}</td><td className="num neg">{qty(u.wasted)}</td>
                    <td className="num">{qty(u.received)}</td><td className="num">{qty(u.adjusted)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!usage.length && <Empty>No stock movements in this period.</Empty>}
          </section>
          <section className="card table-wrap">
            <h2>Current stock levels</h2>
            <table>
              <thead><tr><th>Item</th><th>Kind</th><th className="num">In stock</th><th className="num">Alert at</th><th className="num">Value</th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={`${i.itemType}${i.id}`} className={isLow(i) ? 'row-warn' : ''}>
                    <td>{i.name}</td><td>{i.itemType}</td>
                    <td className="num">{qty(i.stock)} {i.unit}</td><td className="num">{qty(i.lowStock)}</td>
                    <td className="num">{peso((Number(i.stock) || 0) * i.costEach)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <h2>Stock movements in period</h2>
          <MovementTable rows={moves.docs} />
        </>
      )}

      {tab === 'credit' && (
        <>
          <div className="stats">
            <Stat label="Total outstanding" value={peso(owing.reduce((t, a) => t + Number(a.balance), 0))} kind="warn" />
            <Stat label="Accounts owing" value={owing.length} />
            <Stat label="Credit sales (period)" value={peso(sum.byMethod.credit?.total || 0)} sub={`${sum.byMethod.credit?.count || 0} transactions`} />
          </div>
          <section className="card table-wrap">
            <h2>Outstanding balances</h2>
            <table>
              <thead><tr><th>Name</th><th>ID no.</th><th>Type</th><th className="num">Balance</th><th className="num">Limit</th><th className="num">% used</th></tr></thead>
              <tbody>
                {owing.map((a) => (
                  <tr key={a.id}>
                    <td>{a.name}</td><td className="mono">{a.idNumber}</td><td>{a.type}</td>
                    <td className="num">{peso(a.balance)}</td><td className="num">{peso(a.limit)}</td>
                    <td className="num">{a.limit > 0 ? `${Math.round((a.balance / a.limit) * 100)}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!owing.length && <Empty>No outstanding balances.</Empty>}
          </section>
        </>
      )}
    </>
  );
}

import { useEffect, useState } from 'react';
import { Empty, ErrorNote, PageHead, Stat, useToast } from '../components/ui';
import { PAYMENT_METHODS } from '../lib/checkout';
import { MONEY_METHODS } from '../lib/accounting';
import { fmtDateTime, peso } from '../lib/format';
import { exportAccountingExcel, loadAccounting } from '../services/accounting';
import { APP } from '../config/app';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const PRESETS = {
  today: () => { const t = ymd(new Date()); return [t, t]; },
  week: () => { const d = new Date(); d.setDate(d.getDate() - 6); return [ymd(d), ymd(new Date())]; },
  month: () => { const d = new Date(); return [ymd(new Date(d.getFullYear(), d.getMonth(), 1)), ymd(d)]; },
  lastMonth: () => { const d = new Date(); return [ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)), ymd(new Date(d.getFullYear(), d.getMonth(), 0))]; },
  year: () => { const d = new Date(); return [ymd(new Date(d.getFullYear(), 0, 1)), ymd(d)]; },
};
const methodName = (m) => PAYMENT_METHODS[m] || MONEY_METHODS[m] || m;
const Row = ({ label, value, strong, total, neg }) => (
  <div className={`sum-row ${strong ? 'sum-strong' : ''} ${total ? 'sum-total' : ''}`}>
    <span>{label}</span><span className={neg || value < 0 ? 'neg' : ''}>{peso(value)}</span>
  </div>
);

export default function Accounting() {
  const [[from, to], setRange] = useState(PRESETS.month);
  const [by, setBy] = useState('day');
  const [tab, setTab] = useState('summary');
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [exporting, setExporting] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    loadAccounting(from, to, by)
      .then((r) => live && setReport(r))
      .catch((e) => live && setError(e))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [from, to, by, reload]);

  const exportExcel = async () => {
    setExporting(true);
    try {
      await exportAccountingExcel(report);
      toast('Accounting workbook downloaded.');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setExporting(false);
    }
  };

  const r = report;
  return (
    <>
      <PageHead title="Accounting" sub={`${from} to ${to}`}>
        <button className="btn" onClick={() => setReload((n) => n + 1)} disabled={loading}>Refresh</button>
        <button className="btn" onClick={() => window.print()} disabled={!r}>Print</button>
        <button className="btn btn-primary" onClick={exportExcel} disabled={!r || exporting}>{exporting ? 'Preparing…' : 'Export Excel'}</button>
      </PageHead>
      <div className="filters no-print">
        <label className="field-inline">From <input type="date" value={from} max={to} onChange={(e) => setRange([e.target.value, to])} /></label>
        <label className="field-inline">To <input type="date" value={to} min={from} onChange={(e) => setRange([from, e.target.value])} /></label>
        {[['today', 'Today'], ['week', '7 days'], ['month', 'This month'], ['lastMonth', 'Last month'], ['year', 'This year']].map(([k, v]) => (
          <button key={k} className="chip" onClick={() => setRange(PRESETS[k]())}>{v}</button>
        ))}
        <label className="field-inline">Group by
          <select value={by} onChange={(e) => setBy(e.target.value)}>
            <option value="day">Day</option>
            <option value="month">Month</option>
          </select>
        </label>
      </div>
      <div className="tabs no-print">
        {[['summary', 'Compact summary'], ['book', 'Sales book'], ['money', 'Money in & out'], ['ar', 'Receivables & payables'], ['drawer', 'Cash drawer'], ['journal', 'Journal']].map(([k, v]) => (
          <button key={k} className={tab === k ? 'is-on' : ''} onClick={() => setTab(k)}>{v}</button>
        ))}
      </div>
      <ErrorNote error={error} />
      {loading && !r && <div className="center-screen"><div className="spinner" aria-label="Loading" /></div>}

      {r && tab === 'summary' && (
        <>
          <div className="stats">
            <Stat label="Net sales" value={peso(r.pl.netSales)} kind="accent" sub={`${r.receipts} receipts`} />
            <Stat label="Net profit" value={peso(r.pl.netProfit)} kind={r.pl.netProfit < 0 ? 'warn' : undefined} sub={`${r.pl.margin}% margin`} />
            <Stat label="Money in" value={peso(r.money.moneyIn)} sub={`Out ${peso(r.money.moneyOut)}`} />
            <Stat label="Owed to us (credit)" value={peso(r.receivables.outstanding)} sub={`We owe suppliers ${peso(r.payables.outstanding)}`} />
          </div>
          <section className="card printable pl">
            <h2>{APP.canteenName} · Accounting summary · {from} to {to}</h2>
            <h3 className="mt">Income</h3>
            <Row label="Sales before discounts" value={r.pl.grossSales + r.discounts} />
            <Row label="− Discounts" value={r.discounts} />
            <Row label="− Refunds and voids" value={r.pl.refundTotal} />
            <Row label="Net sales" value={r.pl.netSales} strong />
            <Row label="− Cost of goods sold" value={r.pl.cogs} />
            <Row label="Gross profit" value={r.pl.grossProfit} strong />
            <Row label="− Spoiled / expired / wasted stock" value={r.pl.waste} />
            <Row label="− Stock count differences" value={r.pl.countLoss} />
            {Object.entries(r.pl.byCategory).map(([k, v]) => <Row key={k} label={`− ${k}`} value={v} />)}
            <Row label="Net profit" value={r.pl.netProfit} total />

            <h3 className="mt">Money in and out</h3>
            {r.money.rows.map((m) => <Row key={m.method} label={`${m.label}: in ${peso(m.moneyIn)} · out ${peso(m.moneyOut)}`} value={m.net} />)}
            <Row label="Net money movement" value={r.money.net} strong />
            <p className="muted small">Credit sales are not money yet. They count once the student or staff member repays.</p>

            <h3 className="mt">Receivables (credit)</h3>
            <Row label="Credit sales in period" value={r.receivables.creditSales} />
            <Row label="− Repayments collected" value={r.receivables.collected} />
            <Row label="− Credit refunded" value={r.receivables.creditRefunds} />
            <Row label="Outstanding now" value={r.receivables.outstanding} strong />

            <h3 className="mt">Payables (suppliers)</h3>
            <Row label="Deliveries billed in period" value={r.payables.billed} />
            <Row label="Paid to suppliers in period" value={r.payables.paid} />
            <Row label="Owed now" value={r.payables.outstanding} strong />
            {r.payables.overdue > 0 && <Row label="… of which overdue" value={r.payables.overdue} neg />}

            <h3 className="mt">Cash drawer</h3>
            <Row label={`Expected in ${r.drawer.rows.length} closed shift(s)`} value={r.drawer.expected} />
            <Row label="Counted" value={r.drawer.counted} />
            <Row label="Over (+) / short (−)" value={r.drawer.net} strong />
            {r.drawer.open > 0 && <p className="muted small">{r.drawer.open} shift(s) still open aren’t included.</p>}
            <p className="muted small mt">Cost of goods uses each product’s cost at the time of sale. Waste and count differences use current item costs.</p>
          </section>
        </>
      )}

      {r && tab === 'book' && (
        <section className="card table-wrap printable">
          <h2>{by === 'month' ? 'Monthly' : 'Daily'} sales book · {from} to {to}</h2>
          <table>
            <thead>
              <tr>
                <th>{by === 'month' ? 'Month' : 'Date'}</th><th className="num">Receipts</th><th>Receipt nos.</th>
                <th className="num">Discounts</th><th className="num">Refunds</th><th className="num">Net sales</th>
                <th className="num">Cash</th><th className="num">GCash</th><th className="num">Credit</th>
                <th className="num">Collected</th><th className="num">Expenses</th><th className="num">Suppliers</th>
              </tr>
            </thead>
            <tbody>
              {r.book.rows.map((d) => (
                <tr key={d.period} className={d.receipts ? '' : 'muted'}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>{d.period}</td><td className="num">{d.receipts}</td>
                  <td className="mono small" style={{ whiteSpace: 'nowrap' }}>{d.firstReceipt ? `${d.firstReceipt} – ${d.lastReceipt}` : '—'}</td>
                  <td className="num">{peso(d.discounts)}</td><td className="num">{peso(d.refunds)}</td><td className="num"><strong>{peso(d.netSales)}</strong></td>
                  <td className="num">{peso(d.cash)}</td><td className="num">{peso(d.gcash)}</td><td className="num">{peso(d.credit)}</td>
                  <td className="num">{peso(d.collections)}</td><td className="num">{peso(d.expenses)}</td><td className="num">{peso(d.supplierPaid)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th>Total</th><th className="num">{r.book.totals.receipts || 0}</th><th />
                <th className="num">{peso(r.book.totals.discounts)}</th><th className="num">{peso(r.book.totals.refunds)}</th><th className="num">{peso(r.book.totals.netSales)}</th>
                <th className="num">{peso(r.book.totals.cash)}</th><th className="num">{peso(r.book.totals.gcash)}</th><th className="num">{peso(r.book.totals.credit)}</th>
                <th className="num">{peso(r.book.totals.collections)}</th><th className="num">{peso(r.book.totals.expenses)}</th><th className="num">{peso(r.book.totals.supplierPaid)}</th>
              </tr>
            </tfoot>
          </table>
        </section>
      )}

      {r && tab === 'money' && (
        <section className="card table-wrap printable">
          <h2>Money in and out by payment method</h2>
          <table>
            <thead>
              <tr><th>Method</th><th className="num">Sales</th><th className="num">Credit collected</th><th className="num">Money in</th><th className="num">Refunds paid</th><th className="num">Expenses</th><th className="num">Paid suppliers</th><th className="num">Money out</th><th className="num">Net</th></tr>
            </thead>
            <tbody>
              {r.money.rows.map((m) => (
                <tr key={m.method}>
                  <td>{m.label}</td><td className="num">{peso(m.sales)}</td><td className="num">{peso(m.collections)}</td><td className="num"><strong>{peso(m.moneyIn)}</strong></td>
                  <td className="num">{peso(m.refunds)}</td><td className="num">{peso(m.expenses)}</td><td className="num">{peso(m.suppliers)}</td><td className="num"><strong>{peso(m.moneyOut)}</strong></td>
                  <td className={`num ${m.net < 0 ? 'neg' : ''}`}><strong>{peso(m.net)}</strong></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr><th>Total</th><th /><th /><th className="num">{peso(r.money.moneyIn)}</th><th /><th /><th /><th className="num">{peso(r.money.moneyOut)}</th><th className="num">{peso(r.money.net)}</th></tr>
            </tfoot>
          </table>
          <p className="muted small mt">Credit sales ({peso(r.receivables.creditSales)}) aren’t money in until they’re repaid. They’re under Receivables.</p>
        </section>
      )}

      {r && tab === 'ar' && (
        <>
          <div className="stats">
            <Stat label="Owed to us" value={peso(r.receivables.outstanding)} kind="warn" sub={`Students ${peso(r.receivables.students)} · Staff ${peso(r.receivables.staff)}`} />
            <Stat label="Change in period" value={peso(r.receivables.netChange)} sub="Credit sales − repayments − credit refunds" />
            <Stat label="We owe suppliers" value={peso(r.payables.outstanding)} kind={r.payables.overdue > 0 ? 'warn' : undefined} sub={r.payables.overdue > 0 ? `${peso(r.payables.overdue)} overdue` : 'Nothing overdue'} />
            <Stat label="Supplier bills in period" value={peso(r.payables.billed)} sub={`Paid ${peso(r.payables.paid)}`} />
          </div>
          <div className="grid-dash">
            <section className="card table-wrap">
              <h2>Receivables by account</h2>
              <table>
                <thead><tr><th>Name</th><th>ID no.</th><th>Type</th><th className="num">Balance</th></tr></thead>
                <tbody>{r.receivables.accounts.map((a) => <tr key={`${a.name}${a.idNumber}`}><td>{a.name}</td><td className="mono">{a.idNumber}</td><td>{a.type}</td><td className="num">{peso(a.balance)}</td></tr>)}</tbody>
              </table>
              {!r.receivables.accounts.length && <Empty>No outstanding balances.</Empty>}
            </section>
            <section className="card table-wrap">
              <h2>Payables by supplier</h2>
              <table>
                <thead><tr><th>Supplier</th><th className="num">Unpaid deliveries</th><th className="num">Owed</th><th className="num">Overdue</th></tr></thead>
                <tbody>{r.payables.suppliers.map((s) => <tr key={s.supplier}><td>{s.supplier}</td><td className="num">{s.deliveries}</td><td className="num">{peso(s.owed)}</td><td className={`num ${s.overdue ? 'neg' : ''}`}>{peso(s.overdue)}</td></tr>)}</tbody>
              </table>
              {!r.payables.suppliers.length && <Empty>Nothing owed to suppliers.</Empty>}
            </section>
          </div>
        </>
      )}

      {r && tab === 'drawer' && (
        <>
          <div className="stats">
            <Stat label="Closed shifts" value={r.drawer.rows.length} sub={r.drawer.open ? `${r.drawer.open} still open` : undefined} />
            <Stat label="Over" value={peso(r.drawer.over)} />
            <Stat label="Short" value={peso(r.drawer.short)} kind={r.drawer.short > 0 ? 'warn' : undefined} />
            <Stat label="Net over / short" value={peso(r.drawer.net)} />
          </div>
          <section className="card table-wrap">
            <table>
              <thead><tr><th>Shift</th><th>Cashier</th><th>Closed</th><th className="num">Expected</th><th className="num">Counted</th><th className="num">Over / short</th></tr></thead>
              <tbody>
                {r.drawer.rows.map((s) => (
                  <tr key={s.shiftNo} className={s.difference < 0 ? 'row-warn' : ''}>
                    <td className="mono">{s.shiftNo}</td><td>{s.staff}</td><td>{fmtDateTime(s.closedAt)}</td>
                    <td className="num">{peso(s.expected)}</td><td className="num">{peso(s.counted)}</td><td className={`num ${s.difference < 0 ? 'neg' : ''}`}>{peso(s.difference)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!r.drawer.rows.length && <Empty>No closed shifts in this period.</Empty>}
          </section>
        </>
      )}

      {r && tab === 'journal' && (
        <section className="card table-wrap">
          <h2>Journal · {r.journal.length} entries</h2>
          <table>
            <thead><tr><th>Date</th><th>Type</th><th>Ref no.</th><th>Party</th><th>Method</th><th className="num">Money in</th><th className="num">Money out</th><th>Note</th></tr></thead>
            <tbody>
              {r.journal.slice(-500).reverse().map((x, i) => (
                <tr key={`${x.ref}${i}`}>
                  <td>{fmtDateTime(x.when)}</td><td>{x.type}</td><td className="mono">{x.ref}</td><td>{x.party}</td><td>{methodName(x.method)}</td>
                  <td className="num">{x.credit ? peso(x.credit) : ''}</td><td className="num neg">{x.debit ? peso(x.debit) : ''}</td><td className="small muted">{x.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!r.journal.length && <Empty>No transactions in this period.</Empty>}
          {r.journal.length > 500 && <p className="muted small">Showing the latest 500. Export Excel for all {r.journal.length} entries.</p>}
        </section>
      )}
    </>
  );
}

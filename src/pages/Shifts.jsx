import { useEffect, useState } from 'react';
import { db, collection, limit, orderBy, query } from '../db';
import { useAuth } from '../context/AuthContext';
import { useCollection } from '../hooks/useCollection';
import { useShift } from '../hooks/useShift';
import { Badge, Empty, ErrorNote, Field, Modal, PageHead, Stat, useToast } from '../components/ui';
import { APP } from '../config/app';
import { DENOMINATIONS, countTotal } from '../lib/shifts';
import { fmtDateTime, peso } from '../lib/format';
import { addCashEvent, closeShift, openShift, shiftActivity } from '../services/shifts';

export const canSeeAllShifts = (profile) => ['admin', 'manager'].includes(profile?.role);

export function OpenShiftForm({ onOpened }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [cash, setCash] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const s = await openShift({ openingCash: cash, profile });
      toast(`${s.shiftNo} opened.`);
      onOpened?.(s);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="row-inline wrap" onSubmit={submit}>
      <Field label="Cash in the drawer now (₱)"><input inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="e.g. 500" required /></Field>
      <button className="btn btn-primary" disabled={busy}>{busy ? 'Opening…' : 'Open shift'}</button>
    </form>
  );
}

export default function Shifts() {
  const { profile } = useAuth();
  const toast = useToast();
  const { shift, loading } = useShift();
  const all = canSeeAllShifts(profile);
  const list = useCollection(() => query(collection(db, 'shifts'), orderBy('openedAt', 'desc'), limit(100)), []);
  const [activity, setActivity] = useState(null);
  const [closing, setClosing] = useState(false);
  const [report, setReport] = useState(null);
  const [cashForm, setCashForm] = useState({ type: 'out', amount: '', reason: '' });

  const refresh = async () => {
    if (shift) setActivity(await shiftActivity(shift).catch(() => null));
  };
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shift?.id, shift?.cashEvents?.length]);

  const rows = list.docs.filter((s) => all || s.staffId === profile.id);
  const sum = activity?.summary;

  const addCash = async (e) => {
    e.preventDefault();
    try {
      await addCashEvent({ shiftId: shift.id, ...cashForm, profile });
      toast(cashForm.type === 'in' ? 'Cash added to drawer.' : 'Cash taken out recorded.');
      setCashForm({ type: 'out', amount: '', reason: '' });
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <>
      <PageHead title="Shifts & cash drawer" sub="Open a shift with your starting cash, close it with a count" />

      <section className="card">
        {loading ? <div className="spinner" /> : !shift ? (
          <>
            <h2>You have no open shift</h2>
            <p className="muted">Count the cash in the drawer, then open your shift to start selling.</p>
            <OpenShiftForm />
          </>
        ) : (
          <>
            <div className="row-between">
              <h2>{shift.shiftNo} · {shift.staffName} <Badge kind="ok">Open</Badge></h2>
              <div className="row-inline">
                <button className="btn btn-sm" onClick={refresh}>Refresh</button>
                <button className="btn btn-sm" onClick={() => setReport({ ...shift, summary: sum, live: true })}>Print X report</button>
                <button className="btn btn-primary" onClick={() => setClosing(true)}>Close shift</button>
              </div>
            </div>
            <p className="muted small">Opened {fmtDateTime(shift.openedAt)} with {peso(shift.openingCash)}.</p>
            {sum && (
              <div className="stats">
                <Stat label="Sales" value={peso(sum.grossSales)} sub={`${sum.salesCount} sales`} />
                <Stat label="Cash sales" value={peso(sum.cashSales)} />
                <Stat label="GCash / credit" value={`${peso(sum.gcashSales)} / ${peso(sum.creditSales)}`} />
                <Stat label="Refunds" value={peso(sum.refundTotal)} sub={`${sum.refundCount} refunds`} />
              </div>
            )}
            <form className="box row-inline wrap" onSubmit={addCash}>
              <strong>Cash in / out</strong>
              <select value={cashForm.type} onChange={(e) => setCashForm({ ...cashForm, type: e.target.value })}>
                <option value="out">Take cash out (paid for something)</option>
                <option value="in">Put cash in (extra change)</option>
              </select>
              <input inputMode="decimal" placeholder="Amount" value={cashForm.amount} onChange={(e) => setCashForm({ ...cashForm, amount: e.target.value })} />
              <input placeholder="What for?" value={cashForm.reason} onChange={(e) => setCashForm({ ...cashForm, reason: e.target.value })} />
              <button className="btn">Save</button>
            </form>
            {(shift.cashEvents || []).length > 0 && (
              <ul className="plain-list mt">
                {shift.cashEvents.map((e, i) => (
                  <li key={i} className="row-between small">
                    <span>{e.type === 'in' ? 'In' : 'Out'} · {e.reason} · {e.byName} · {fmtDateTime(e.at)}</span>
                    <strong className={e.type === 'in' ? 'pos' : 'neg'}>{e.type === 'in' ? '+' : '−'}{peso(e.amount)}</strong>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <h2>{all ? 'All shifts' : 'My shifts'}</h2>
      <ErrorNote error={list.error} />
      <div className="card table-wrap">
        <table>
          <thead><tr><th>Shift</th><th>Cashier</th><th>Opened</th><th>Closed</th><th className="num">Sales</th><th className="num">Expected cash</th><th className="num">Counted</th><th className="num">Over / short</th></tr></thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => setReport(s)}>
                <td className="mono">{s.shiftNo}</td>
                <td>{s.staffName}</td>
                <td>{fmtDateTime(s.openedAt)}</td>
                <td>{s.status === 'open' ? <Badge kind="ok">Open</Badge> : fmtDateTime(s.closedAt)}</td>
                <td className="num">{s.summary ? peso(s.summary.grossSales) : '—'}</td>
                <td className="num">{s.status === 'closed' ? peso(s.expectedCash) : '—'}</td>
                <td className="num">{s.status === 'closed' ? peso(s.countedCash) : '—'}</td>
                <td className={`num ${s.difference < 0 ? 'neg' : s.difference > 0 ? 'pos' : ''}`}>
                  {s.status === 'closed' ? `${s.difference > 0 ? '+' : ''}${peso(s.difference)}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.loading && !rows.length && <Empty>No shifts yet.</Empty>}
      </div>

      {closing && shift && <CloseShift shift={shift} onClose={() => setClosing(false)} onDone={(r) => { setClosing(false); setReport(r); }} />}
      {report && <ShiftReport shift={report} onClose={() => setReport(null)} />}
    </>
  );
}

function CloseShift({ shift, onClose, onDone }) {
  const { profile } = useAuth();
  const toast = useToast();
  const [counts, setCounts] = useState({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const total = countTotal(counts);

  const submit = async () => {
    if (!window.confirm(`Close ${shift.shiftNo} with ${peso(total)} counted?`)) return;
    setBusy(true);
    try {
      const r = await closeShift({ shift, counts, notes, profile });
      toast(r.difference === 0 ? 'Shift closed. Cash matches exactly.' : `Shift closed. ${r.difference > 0 ? 'Over' : 'Short'} by ${peso(Math.abs(r.difference))}.`, r.difference < 0 ? 'warn' : 'ok');
      onDone({ ...shift, status: 'closed', ...r, closedAt: new Date(), closedByName: profile.displayName, counts, notes, summary: (await shiftActivity(shift)).summary });
    } catch (e) {
      toast(e.message, 'error');
      setBusy(false);
    }
  };

  return (
    <Modal title={`Close ${shift.shiftNo}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Closing…' : 'Close shift'}</button></>}>
      <p className="muted small">Count every bill and coin in the drawer. The expected amount is shown after you close, so the count stays honest.</p>
      <div className="denoms">
        {DENOMINATIONS.map((d) => (
          <label key={d} className="denom">
            <span>{d >= 1 ? `₱${d}` : '25¢'}</span>
            <input inputMode="numeric" placeholder="0" value={counts[d] ?? ''} onChange={(e) => setCounts({ ...counts, [d]: e.target.value.replace(/\D/g, '') })} />
            <span className="muted small">{peso(d * (Number(counts[d]) || 0))}</span>
          </label>
        ))}
      </div>
      <div className="sum-row sum-total mt"><span>Counted</span><span>{peso(total)}</span></div>
      <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything unusual" /></Field>
    </Modal>
  );
}

function ShiftReport({ shift: s, onClose }) {
  const [summary, setSummary] = useState(s.summary || null);
  useEffect(() => {
    if (!summary) shiftActivity(s).then((a) => setSummary(a.summary)).catch(() => {});
  }, [s, summary]);
  const x = summary || {};
  const row = (label, v, cls = '') => <div className={`r-row ${cls}`}><span>{label}</span><span>{v}</span></div>;
  return (
    <Modal title={`${s.status === 'open' ? 'X report (shift still open)' : 'Shift report'} · ${s.shiftNo}`} onClose={onClose}
      footer={<button className="btn btn-primary" onClick={() => window.print()}>Print</button>}>
      <div className="receipt" id="receipt">
        <div className="r-center"><strong className="r-title">{APP.canteenName}</strong><div>{s.status === 'open' ? 'X REPORT' : 'Z REPORT'}</div></div>
        <div className="r-rule" />
        {row('Shift', s.shiftNo)}
        {row('Cashier', s.staffName)}
        {row('Opened', fmtDateTime(s.openedAt))}
        {s.closedAt && row('Closed', fmtDateTime(s.closedAt))}
        <div className="r-rule" />
        {row('Sales', `${x.salesCount ?? 0}`)}
        {row('Gross sales', peso(x.grossSales))}
        {row('  Cash', peso(x.cashSales))}
        {row('  GCash', peso(x.gcashSales))}
        {row('  Credit', peso(x.creditSales))}
        {row('Discounts given', peso(x.discounts))}
        {row(`Refunds (${x.refundCount ?? 0})`, `−${peso(x.refundTotal)}`)}
        {row('Credit repaid (cash)', peso(x.cashRepayments))}
        {row('Credit repaid (GCash)', peso(x.gcashRepayments))}
        <div className="r-rule" />
        {row('Opening cash', peso(x.openingCash))}
        {row('+ Cash sales', peso(x.cashSales))}
        {row('+ Cash repayments', peso(x.cashRepayments))}
        {row('+ Cash put in', peso(x.payIns))}
        {row('− Cash taken out', peso(x.payOuts))}
        {row('− Cash refunds', peso(x.cashRefunds))}
        {row('Expected in drawer', peso(s.status === 'closed' ? s.expectedCash : x.expectedCash), 'r-total')}
        {s.status === 'closed' && (
          <>
            {row('Counted', peso(s.countedCash))}
            {row(s.difference < 0 ? 'SHORT' : s.difference > 0 ? 'OVER' : 'Difference', peso(s.difference), 'r-total')}
            {s.notes && <div className="small">Note: {s.notes}</div>}
            {row('Closed by', s.closedByName)}
          </>
        )}
        <div className="r-rule" />
        <div className="signatures-r"><span>Cashier: __________</span><span>Checked: __________</span></div>
      </div>
    </Modal>
  );
}

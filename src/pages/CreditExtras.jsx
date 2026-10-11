import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useAuth } from '../context/AuthContext';
import { Field, Modal, useToast } from '../components/ui';
import { APP } from '../config/app';
import { buildStatement, statementText } from '../lib/statements';
import { dayKey, endOfDay, peso, startOfDay } from '../lib/format';
import { round2 } from '../lib/checkout';
import { logAudit } from '../lib/audit';
import { recordRepayment } from '../services/credit';

const monthStart = () => {
  const d = new Date();
  return dayKey(new Date(d.getFullYear(), d.getMonth(), 1));
};

/* ---------------- statement ---------------- */

export function StatementModal({ account, sales, refunds, payments, onClose }) {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(dayKey(new Date()));
  const f = startOfDay(new Date(`${from}T00:00`));
  const t = endOfDay(new Date(`${to}T00:00`));
  const st = buildStatement({ sales, refunds, payments, from: f, to: t });
  const emailTo = account.type === 'student' ? account.guardianEmail || account.email : account.email;
  const text = statementText({ account, statement: st, from: f, to: t, canteenName: APP.canteenName, fmt: peso });
  const mailto = `mailto:${encodeURIComponent(emailTo || '')}?subject=${encodeURIComponent(`${APP.canteenName} credit statement — ${account.name}`)}&body=${encodeURIComponent(text)}`;

  return (
    <Modal wide title={`Statement · ${account.name}`} onClose={onClose}
      footer={
        <>
          <a className="btn" href={mailto}>{emailTo ? `Email to ${emailTo}` : 'Email…'}</a>
          <button className="btn" onClick={() => navigator.clipboard?.writeText(text)}>Copy text</button>
          <button className="btn btn-primary" onClick={() => window.print()}>Print</button>
        </>
      }>
      <div className="filters no-print">
        <label className="field-inline">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field-inline">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <div className="printable statement">
        <div className="row-between">
          <div>
            <strong>{APP.canteenName}</strong>
            <div className="muted small">{APP.address}</div>
          </div>
          <div className="num">
            <strong>Credit statement</strong>
            <div className="muted small">{f.toLocaleDateString()} – {t.toLocaleDateString()}</div>
          </div>
        </div>
        <p className="mt">
          <strong>{account.name}</strong> · {account.idNumber} · {account.type}
          {account.guardianName && <span className="muted"> · Guardian: {account.guardianName}</span>}
        </p>
        <table>
          <thead><tr><th>Date</th><th>Type</th><th>Ref</th><th>Details</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
          <tbody>
            <tr><td colSpan={5}><em>Opening balance</em></td><td className="num">{peso(st.opening)}</td></tr>
            {st.lines.map((l, i) => (
              <tr key={i}>
                <td>{l.when.toLocaleDateString()}</td>
                <td>{l.kind}</td>
                <td className="mono">{l.ref}</td>
                <td className="small">{l.detail}</td>
                <td className={`num ${l.amount < 0 ? 'pos' : ''}`}>{l.amount < 0 ? '−' : ''}{peso(Math.abs(l.amount))}</td>
                <td className="num">{peso(l.balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="sum-row mt"><span>Purchases</span><span>{peso(st.purchases)}</span></div>
        <div className="sum-row"><span>Payments and refunds</span><span>−{peso(st.credits)}</span></div>
        <div className="sum-row sum-total"><span>Balance due</span><span>{peso(st.closing)}</span></div>
      </div>
    </Modal>
  );
}

/* ---------------- QR cards ---------------- */

function QrImage({ text }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    QRCode.toDataURL(String(text), { margin: 1, width: 240 }).then(setSrc).catch(() => setSrc(''));
  }, [text]);
  return src ? <img src={src} alt={`QR code ${text}`} className="qr" /> : <div className="qr" />;
}

/** Printable cards with each account's QR code (contains the ID number) for scanning at the counter. */
export function QrCards({ accounts, onClose }) {
  return (
    <Modal wide title={`ID QR cards (${accounts.length})`} onClose={onClose} footer={<button className="btn btn-primary" onClick={() => window.print()}>Print cards</button>}>
      <p className="muted small no-print">Print and stick on ID cards, or let students show it on their phone. Scanning it at the cashier picks their credit account.</p>
      <div className="qr-grid printable">
        {accounts.filter((a) => a.idNumber).map((a) => (
          <div className="qr-card" key={a.id}>
            <QrImage text={a.idNumber} />
            <div>
              <strong>{a.name}</strong>
              <div className="mono small">{a.idNumber}</div>
              <div className="muted small">{APP.canteenName} · {a.type}</div>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/* ---------------- payroll deduction ---------------- */

async function downloadPayroll(accounts) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Payroll deduction');
  ws.columns = [
    { header: 'Employee ID', key: 'id', width: 16 },
    { header: 'Name', key: 'name', width: 30 },
    { header: 'Amount to deduct', key: 'amount', width: 18, style: { numFmt: '#,##0.00' } },
    { header: 'Credit limit', key: 'limit', width: 14, style: { numFmt: '#,##0.00' } },
  ];
  accounts.forEach((a) => ws.addRow({ id: a.idNumber, name: a.name, amount: Number(a.balance), limit: Number(a.limit) }));
  ws.addRow({});
  ws.addRow({ name: 'TOTAL', amount: round2(accounts.reduce((t, a) => t + Number(a.balance), 0)) });
  ws.getRow(1).font = { bold: true };
  const buf = await wb.xlsx.writeBuffer();
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `canteen-payroll-deduction-${dayKey(new Date())}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function PayrollModal({ accounts, onClose }) {
  const { profile } = useAuth();
  const toast = useToast();
  const staff = accounts.filter((a) => a.type === 'staff' && Number(a.balance) > 0).sort((a, b) => a.name.localeCompare(b.name));
  const [amounts, setAmounts] = useState(() => Object.fromEntries(staff.map((a) => [a.id, String(a.balance)])));
  const [picked, setPicked] = useState(() => staff.map((a) => a.id));
  const [period, setPeriod] = useState('');
  const [busy, setBusy] = useState(false);
  const total = round2(picked.reduce((t, id) => t + (Number(amounts[id]) || 0), 0));

  const post = async () => {
    if (!window.confirm(`Record payroll deductions for ${picked.length} staff, total ${peso(total)}?`)) return;
    setBusy(true);
    let ok = 0;
    const failed = [];
    for (const id of picked) {
      const a = staff.find((x) => x.id === id);
      try {
        await recordRepayment({ accountId: id, amount: amounts[id], method: 'payroll', note: period ? `Payroll ${period}` : 'Payroll deduction', profile });
        ok++;
      } catch (e) {
        failed.push(`${a.name}: ${e.message}`);
      }
    }
    await logAudit(profile, 'credit.payroll', { count: ok, total, period });
    setBusy(false);
    toast(failed.length ? `${ok} recorded. Problems:\n${failed.join('\n')}` : `${ok} payroll deductions recorded.`, failed.length ? 'warn' : 'ok');
    if (!failed.length) onClose();
  };

  return (
    <Modal wide title="Payroll deduction (staff)" onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => downloadPayroll(staff.filter((a) => picked.includes(a.id)))}>Download list for HR (.xlsx)</button>
          <button className="btn btn-primary" disabled={busy || !picked.length} onClick={post}>{busy ? 'Recording…' : `Record deductions · ${peso(total)}`}</button>
        </>
      }>
      <p className="muted small">1) Download the list and send it to HR/payroll. 2) After payday, record the deductions here — each one lowers the staff member’s balance.</p>
      <Field label="Payroll period (optional)"><input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="e.g. Oct 1–15" /></Field>
      <table className="mt">
        <thead><tr><th /><th>Staff</th><th>ID</th><th className="num">Balance</th><th className="num">Deduct</th></tr></thead>
        <tbody>
          {staff.map((a) => (
            <tr key={a.id}>
              <td><input type="checkbox" checked={picked.includes(a.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, a.id] : picked.filter((x) => x !== a.id))} /></td>
              <td>{a.name}</td>
              <td className="mono">{a.idNumber}</td>
              <td className="num">{peso(a.balance)}</td>
              <td className="num"><input className="num" inputMode="decimal" value={amounts[a.id]} onChange={(e) => setAmounts({ ...amounts, [a.id]: e.target.value })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {!staff.length && <p className="muted">No staff accounts with a balance.</p>}
    </Modal>
  );
}

export function CreditExtrasButtons({ accounts, manage, onQrAll }) {
  const [payroll, setPayroll] = useState(false);
  return (
    <>
      <button className="btn" onClick={onQrAll}>Print QR cards</button>
      {manage && <button className="btn" onClick={() => setPayroll(true)}>Payroll deduction</button>}
      {payroll && <PayrollModal accounts={accounts} onClose={() => setPayroll(false)} />}
    </>
  );
}

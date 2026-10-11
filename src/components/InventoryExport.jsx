import { useState } from 'react';
import { Field, Modal, useToast } from './ui';
import { dayKey } from '../lib/format';
import { exportInventoryExcel, exportInventoryPdf, loadInventoryReport } from '../services/inventoryReport';

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dayKey(d);
};

/** Buttons that export the inventory report for a period. Without from/to it asks for the period. */
export default function InventoryExport({ from, to }) {
  const toast = useToast();
  const [asking, setAsking] = useState(null); // 'pdf' | 'xlsx'
  const [range, setRange] = useState({ from: daysAgo(29), to: dayKey(new Date()) });
  const [busy, setBusy] = useState('');

  const run = async (kind, f, t) => {
    setBusy(kind);
    try {
      const report = await loadInventoryReport(f, t);
      if (kind === 'pdf') await exportInventoryPdf(report);
      else await exportInventoryExcel(report);
      toast(`Inventory report downloaded (${kind === 'pdf' ? 'PDF' : 'Excel'}).`);
      setAsking(null);
    } catch (e) {
      toast(`Export failed: ${e.message}`, 'error');
    } finally {
      setBusy('');
    }
  };
  const click = (kind) => (from && to ? run(kind, from, to) : setAsking(kind));

  return (
    <>
      <button className="btn" disabled={!!busy} onClick={() => click('xlsx')}>{busy === 'xlsx' ? 'Preparing…' : 'Export Excel'}</button>
      <button className="btn" disabled={!!busy} onClick={() => click('pdf')}>{busy === 'pdf' ? 'Preparing…' : 'Export PDF'}</button>
      {asking && (
        <Modal title={`Inventory report (${asking === 'pdf' ? 'PDF' : 'Excel'})`} onClose={() => setAsking(null)}
          footer={<><button className="btn" onClick={() => setAsking(null)}>Cancel</button><button className="btn btn-primary" disabled={!!busy} onClick={() => run(asking, range.from, range.to)}>{busy ? 'Preparing…' : 'Download'}</button></>}>
          <p className="muted small">Includes current stock levels, low and out-of-stock items, expiring batches, and stock used, wasted and received in the period, with every movement.</p>
          <div className="grid-2">
            <Field label="From"><input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
            <Field label="To"><input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}

// Inventory report: stock levels, low/out of stock, expiring batches, consumption & waste,
// and the movement log for a period — exported as Excel or PDF.
import { db, collection, getDocs, orderBy, query, where } from '../db';
import { APP } from '../config/app';
import { round2 } from '../lib/checkout';
import { dayKey, endOfDay, startOfDay, toDate } from '../lib/format';
import { daysLeft } from '../lib/inventoryMath';
import { summarizeMovements } from '../lib/reports';

const REASONS = { receive: 'Received', adjust: 'Adjustment', spoiled: 'Spoiled', expired: 'Expired', wasted: 'Wasted', sale: 'Sale', initial: 'Opening stock', count: 'Stock count', refund: 'Refund (returned)' };

export const stockStatus = (stock, lowStock) => (Number(stock) <= 0 ? 'Out of stock' : Number(stock) <= Number(lowStock || 0) ? 'Low' : 'OK');

/** Builds the report data (pure). */
export function buildInventoryReport({ products, ingredients, categories = [], movements, batches = [], from, to, today = new Date() }) {
  const catName = Object.fromEntries(categories.map((c) => [c.id, c.name]));
  const items = [
    ...products.filter((p) => p.trackStock && !p.archived).map((p) => ({ ...p, kind: 'Product', category: catName[p.categoryId] || '' })),
    ...ingredients.filter((i) => !i.archived).map((i) => ({ ...i, kind: 'Ingredient', category: '' })),
  ]
    .map((i) => {
      const stock = Number(i.stock) || 0;
      const cost = Number(i.cost) || 0;
      return { name: i.name, kind: i.kind, category: i.category, unit: i.unit || '', stock, lowStock: Number(i.lowStock) || 0, status: stockStatus(stock, i.lowStock), cost, value: round2(Math.max(stock, 0) * cost) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const attention = items.filter((i) => i.status !== 'OK').sort((a, b) => a.stock - b.stock);
  const expiring = batches
    .filter((b) => b.status !== 'closed' && b.expiryDate && daysLeft(b.expiryDate, today) <= 14)
    .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate))
    .map((b) => ({ name: b.name, qty: Number(b.qty) || 0, unit: b.unit || '', expiryDate: b.expiryDate, daysLeft: daysLeft(b.expiryDate, today), delivery: b.deliveryNo || '' }));
  const usage = summarizeMovements(movements);
  const log = [...movements]
    .sort((a, b) => (toDate(a.createdAt)?.getTime() || 0) - (toDate(b.createdAt)?.getTime() || 0))
    .map((m) => ({ when: toDate(m.createdAt), item: m.itemName, kind: m.itemType === 'product' ? 'Product' : 'Ingredient', reason: REASONS[m.reason] || m.reason, change: Number(m.change) || 0, after: Number(m.stockAfter) || 0, note: m.note || '', by: m.byName || '' }));

  return {
    title: `${APP.canteenName} — Inventory report`,
    period: `${dayKey(from)} to ${dayKey(to)}`,
    generated: new Date().toLocaleString(APP.locale),
    summary: {
      items: items.length,
      value: round2(items.reduce((t, i) => t + i.value, 0)),
      low: items.filter((i) => i.status === 'Low').length,
      out: items.filter((i) => i.status === 'Out of stock').length,
      negative: items.filter((i) => i.stock < 0).length,
      expiring: expiring.length,
      received: round2(usage.reduce((t, u) => t + u.received, 0)),
      used: round2(usage.reduce((t, u) => t + u.used, 0)),
      wasted: round2(usage.reduce((t, u) => t + u.wasted, 0)),
    },
    items,
    attention,
    expiring,
    usage,
    log,
  };
}

/** Loads everything needed for the period and builds the report. */
export async function loadInventoryReport(fromDay, toDay) {
  const from = startOfDay(new Date(`${fromDay}T00:00`));
  const to = endOfDay(new Date(`${toDay}T00:00`));
  const get = (q) => getDocs(q).then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() })));
  const [products, ingredients, categories, movements, batches] = await Promise.all([
    get(collection(db, 'products')),
    get(collection(db, 'ingredients')),
    get(collection(db, 'categories')),
    get(query(collection(db, 'stockMovements'), where('createdAt', '>=', from), where('createdAt', '<=', to), orderBy('createdAt', 'asc'))),
    get(collection(db, 'batches')),
  ]);
  return buildInventoryReport({ products, ingredients, categories, movements, batches, from, to });
}

const fileName = (r, ext) => `inventory-report-${r.period.replace(/ to /, '_to_')}.${ext}`;
const fmtDate = (d) => (d ? d.toLocaleString(APP.locale, { dateStyle: 'short', timeStyle: 'short' }) : '');

function save(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------- Excel ---------------- */
export async function inventoryWorkbook(r) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const money = '#,##0.00';
  const sheet = (name, columns, rows, { statusCol } = {}) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns;
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5E46' } };
    rows.forEach((x) => {
      const row = ws.addRow(x);
      if (statusCol && x[statusCol] !== 'OK') {
        row.getCell(statusCol).font = { bold: true, color: { argb: x[statusCol] === 'Low' ? 'FFA8640A' : 'FFB3362D' } };
      }
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    return ws;
  };

  const s = wb.addWorksheet('Summary');
  s.columns = [{ width: 34 }, { width: 22 }];
  [
    [r.title], ['Period', r.period], ['Generated', r.generated], [],
    ['Tracked items', r.summary.items], ['Stock value (at cost, PHP)', r.summary.value], ['Low stock', r.summary.low],
    ['Out of stock', r.summary.out], ['Below zero (sold while out)', r.summary.negative], ['Expiring within 14 days', r.summary.expiring], [],
    ['Received in period (units)', r.summary.received], ['Used in sales (units)', r.summary.used], ['Wasted (units)', r.summary.wasted],
  ].forEach((row, i) => {
    const x = s.addRow(row);
    if (i === 0) x.font = { bold: true, size: 14 };
  });
  s.getCell('B6').numFmt = money;

  const itemCols = [
    { header: 'Item', key: 'name', width: 30 }, { header: 'Kind', key: 'kind', width: 12 }, { header: 'Category', key: 'category', width: 16 },
    { header: 'Unit', key: 'unit', width: 9 }, { header: 'In stock', key: 'stock', width: 11 }, { header: 'Alert at', key: 'lowStock', width: 10 },
    { header: 'Status', key: 'status', width: 14 }, { header: 'Unit cost', key: 'cost', width: 11, style: { numFmt: money } }, { header: 'Value', key: 'value', width: 13, style: { numFmt: money } },
  ];
  sheet('Stock levels', itemCols, r.items, { statusCol: 'status' });
  sheet('Low & out of stock', itemCols, r.attention, { statusCol: 'status' });
  sheet('Expiring', [
    { header: 'Item', key: 'name', width: 30 }, { header: 'Quantity received', key: 'qty', width: 18 }, { header: 'Unit', key: 'unit', width: 9 },
    { header: 'Expiry date', key: 'expiryDate', width: 14 }, { header: 'Days left', key: 'daysLeft', width: 10 }, { header: 'Delivery', key: 'delivery', width: 14 },
  ], r.expiring);
  sheet('Consumption & waste', [
    { header: 'Item', key: 'name', width: 30 }, { header: 'Kind', key: 'itemType', width: 12 }, { header: 'Used in sales', key: 'used', width: 14 },
    { header: 'Wasted', key: 'wasted', width: 10 }, { header: 'Received', key: 'received', width: 11 }, { header: 'Adjusted', key: 'adjusted', width: 11 },
  ], r.usage);
  const log = sheet('Movements', [
    { header: 'Date', key: 'when', width: 18, style: { numFmt: 'yyyy-mm-dd hh:mm' } }, { header: 'Item', key: 'item', width: 28 }, { header: 'Kind', key: 'kind', width: 12 },
    { header: 'Reason', key: 'reason', width: 16 }, { header: 'Change', key: 'change', width: 10 }, { header: 'Stock after', key: 'after', width: 12 },
    { header: 'Note', key: 'note', width: 34 }, { header: 'By', key: 'by', width: 16 },
  ], r.log);
  log.getColumn('when').numFmt = 'yyyy-mm-dd hh:mm';
  return wb;
}

export async function exportInventoryExcel(r) {
  const wb = await inventoryWorkbook(r);
  save(new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName(r, 'xlsx'));
}

/* ---------------- PDF ---------------- */
const n2 = (v) => Number(v || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qn = (v) => (Number.isInteger(Number(v)) ? String(v) : Number(v).toFixed(2));

export async function inventoryPdf(r) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = pdf.internal.pageSize.getWidth();
  const green = [31, 94, 70];
  let y = 48;
  pdf.setFont('helvetica', 'bold').setFontSize(16).text(r.title, 40, y);
  pdf.setFont('helvetica', 'normal').setFontSize(10).setTextColor(90).text(`Period: ${r.period}    Generated: ${r.generated}`, 40, (y += 16));
  pdf.setTextColor(0);

  const s = r.summary;
  autoTable(pdf, {
    startY: y + 14,
    theme: 'plain',
    styles: { fontSize: 10, cellPadding: 3 },
    body: [
      ['Tracked items', String(s.items), 'Stock value (PHP)', n2(s.value)],
      ['Low stock', String(s.low), 'Out of stock', String(s.out)],
      ['Below zero', String(s.negative), 'Expiring (14 days)', String(s.expiring)],
      ['Received (units)', qn(s.received), 'Used in sales (units)', qn(s.used)],
    ],
    columnStyles: { 0: { fontStyle: 'bold' }, 2: { fontStyle: 'bold' } },
  });

  const section = (title, head, body, opts = {}) => {
    let start = pdf.lastAutoTable.finalY + 26;
    if (start > pdf.internal.pageSize.getHeight() - 80) {
      pdf.addPage();
      start = 48;
    }
    pdf.setFont('helvetica', 'bold').setFontSize(12).text(title, 40, start - 8);
    autoTable(pdf, {
      startY: start,
      head: [head],
      body: body.length ? body : [[{ content: 'Nothing to show.', colSpan: head.length, styles: { textColor: 140 } }]],
      styles: { fontSize: 8.5, cellPadding: 3 },
      headStyles: { fillColor: green },
      alternateRowStyles: { fillColor: [246, 242, 234] },
      margin: { left: 40, right: 40 },
      ...opts,
    });
  };
  const statusStyle = (data) => {
    if (data.section === 'body' && data.column.index === 5) {
      const v = data.cell.raw;
      if (v === 'Out of stock') data.cell.styles.textColor = [179, 54, 45];
      if (v === 'Low') data.cell.styles.textColor = [168, 100, 10];
      if (v !== 'OK') data.cell.styles.fontStyle = 'bold';
    }
  };
  const itemRows = (list) => list.map((i) => [i.name, i.kind, `${qn(i.stock)} ${i.unit}`, qn(i.lowStock), n2(i.cost), i.status, n2(i.value)]);
  const itemHead = ['Item', 'Kind', 'In stock', 'Alert at', 'Unit cost', 'Status', 'Value'];
  const right = { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 6: { halign: 'right' } };

  section('Low and out of stock', itemHead, itemRows(r.attention), { columnStyles: right, didParseCell: statusStyle });
  section('Expiring within 14 days', ['Item', 'Qty', 'Expiry', 'Days left', 'Delivery'], r.expiring.map((b) => [b.name, `${qn(b.qty)} ${b.unit}`, b.expiryDate, String(b.daysLeft), b.delivery]));
  section('Stock levels', itemHead, itemRows(r.items), { columnStyles: right, didParseCell: statusStyle });
  section('Consumption and waste in period', ['Item', 'Kind', 'Used in sales', 'Wasted', 'Received', 'Adjusted'],
    r.usage.map((u) => [u.name, u.itemType, qn(u.used), qn(u.wasted), qn(u.received), qn(u.adjusted)]),
    { columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } } });
  section('Stock movements', ['Date', 'Item', 'Reason', 'Change', 'After', 'Note', 'By'],
    r.log.map((m) => [fmtDate(m.when), m.item, m.reason, `${m.change > 0 ? '+' : ''}${qn(m.change)}`, qn(m.after), m.note, m.by]),
    { styles: { fontSize: 7.5, cellPadding: 2 }, columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { cellWidth: 140 } } });

  const pages = pdf.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    pdf.setPage(i);
    pdf.setFontSize(8).setTextColor(140).text(`Page ${i} of ${pages}`, W - 40, pdf.internal.pageSize.getHeight() - 20, { align: 'right' });
  }
  return pdf;
}

export async function exportInventoryPdf(r) {
  const pdf = await inventoryPdf(r);
  pdf.save(fileName(r, 'pdf'));
}

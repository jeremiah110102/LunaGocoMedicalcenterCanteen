// Accounting report: loads a period's sales, refunds, collections, expenses, supplier bills and
// payments, and shift counts, then exports them as one Excel workbook for the accountant.
import { db, collection, getDocs, orderBy, query, where } from '../db';
import { APP } from '../config/app';
import { PAYMENT_METHODS } from '../lib/checkout';
import { endOfDay, startOfDay } from '../lib/format';
import { MONEY_METHODS, buildAccounting } from '../lib/accounting';

/** Loads everything for fromDay..toDay (yyyy-mm-dd) and builds the report. */
export async function loadAccounting(fromDay, toDay, by = 'day') {
  const from = startOfDay(new Date(`${fromDay}T00:00`));
  const to = endOfDay(new Date(`${toDay}T00:00`));
  const get = (q) => getDocs(q).then((s) => s.docs.map((d) => ({ id: d.id, ...d.data() })));
  const inRange = (col, field = 'createdAt') => get(query(collection(db, col), where(field, '>=', from), where(field, '<=', to), orderBy(field, 'asc')));
  const [sales, refunds, payments, movements, expenses, supplierPayments, deliveries, allDeliveries, accounts, shifts, products, ingredients] = await Promise.all([
    inRange('sales'),
    inRange('refunds'),
    inRange('creditPayments'),
    inRange('stockMovements'),
    get(query(collection(db, 'expenses'), where('date', '>=', fromDay), where('date', '<=', toDay))),
    inRange('supplierPayments', 'paidAt'),
    inRange('deliveries', 'receivedAt'),
    get(collection(db, 'deliveries')),
    get(collection(db, 'creditAccounts')),
    inRange('shifts', 'openedAt'),
    get(collection(db, 'products')),
    get(collection(db, 'ingredients')),
  ]);
  const cost = { product: Object.fromEntries(products.map((p) => [p.id, Number(p.cost) || 0])), ingredient: Object.fromEntries(ingredients.map((i) => [i.id, Number(i.cost) || 0])) };
  return buildAccounting({
    sales, refunds, payments, expenses, supplierPayments, deliveries, allDeliveries, accounts, shifts, movements,
    costOf: (t, id) => cost[t]?.[id] || 0, from, to, by,
  });
}

const methodName = (m) => PAYMENT_METHODS[m] || MONEY_METHODS[m] || m || '';

export async function accountingWorkbook(r) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const money = '#,##0.00';
  const head = (ws, n) => {
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5E46' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: n } };
  };
  const table = (name, columns, rows, total) => {
    const ws = wb.addWorksheet(name);
    ws.columns = columns.map((c) => (c.money ? { ...c, style: { numFmt: money } } : c));
    rows.forEach((x) => ws.addRow(x));
    if (total) ws.addRow(total).font = { bold: true };
    head(ws, columns.length);
    return ws;
  };

  // Summary: one page with the numbers that go into the books.
  const s = wb.addWorksheet('Summary');
  s.columns = [{ width: 38 }, { width: 18 }];
  const pl = r.pl;
  const lines = [
    [`${APP.canteenName} — Accounting summary`], ['Period', `${r.period.from} to ${r.period.to}`], ['Generated', new Date().toLocaleString(APP.locale)], [],
    ['INCOME'], ['Sales before discounts', round(pl.grossSales + r.discounts)], ['Discounts', -r.discounts], ['Sales (after discounts)', pl.grossSales],
    ['Refunds and voids', -pl.refundTotal], ['Net sales', pl.netSales], ['Cost of goods sold', -pl.cogs], ['Gross profit', pl.grossProfit],
    ['Spoiled / expired / wasted stock', -pl.waste], ['Stock count differences', -pl.countLoss],
    ...Object.entries(pl.byCategory).map(([k, v]) => [`Expense: ${k}`, -v]),
    ['Net profit', pl.netProfit], ['Net margin %', pl.margin], [],
    ['MONEY IN / OUT'], ...r.money.rows.map((m) => [`${m.label} net (in ${fmt(m.moneyIn)}, out ${fmt(m.moneyOut)})`, m.net]), ['Net money movement', r.money.net], [],
    ['RECEIVABLES (credit)'], ['Credit sales in period', r.receivables.creditSales], ['Repayments collected', -r.receivables.collected],
    ['Credit refunded', -r.receivables.creditRefunds], ['Outstanding now', r.receivables.outstanding], [],
    ['PAYABLES (suppliers)'], ['Deliveries billed in period', r.payables.billed], ['Paid to suppliers in period', r.payables.paid],
    ['Owed now', r.payables.outstanding], ['Overdue now', r.payables.overdue], [],
    ['CASH DRAWER'], ['Closed shifts', r.drawer.rows.length], ['Expected cash', r.drawer.expected], ['Counted cash', r.drawer.counted], ['Over (+) / short (−)', r.drawer.net],
  ];
  lines.forEach((row, i) => {
    const x = s.addRow(row);
    if (i === 0) x.font = { bold: true, size: 14 };
    if (row.length === 1 && i > 0) x.font = { bold: true, color: { argb: 'FF1F5E46' } };
    if (['Net sales', 'Gross profit', 'Net profit', 'Outstanding now', 'Owed now'].includes(row[0])) x.font = { bold: true };
    if (typeof row[1] === 'number' && row[0] !== 'Closed shifts' && row[0] !== 'Net margin %') x.getCell(2).numFmt = money;
  });

  table(r.period.by === 'month' ? 'Monthly sales book' : 'Daily sales book', [
    { header: r.period.by === 'month' ? 'Month' : 'Date', key: 'period', width: 12 }, { header: 'Receipts', key: 'receipts', width: 10 },
    { header: 'First receipt', key: 'firstReceipt', width: 13 }, { header: 'Last receipt', key: 'lastReceipt', width: 13 },
    { header: 'Before discount', key: 'beforeDiscount', width: 15, money: 1 }, { header: 'Discounts', key: 'discounts', width: 12, money: 1 },
    { header: 'Refunds', key: 'refunds', width: 12, money: 1 }, { header: 'Net sales', key: 'netSales', width: 13, money: 1 },
    { header: 'Cash sales', key: 'cash', width: 12, money: 1 }, { header: 'GCash sales', key: 'gcash', width: 12, money: 1 }, { header: 'Credit sales', key: 'credit', width: 12, money: 1 },
    { header: 'Credit collected', key: 'collections', width: 15, money: 1 }, { header: 'Expenses', key: 'expenses', width: 12, money: 1 }, { header: 'Paid suppliers', key: 'supplierPaid', width: 14, money: 1 },
  ], r.book.rows, { ...r.book.totals, firstReceipt: '', lastReceipt: '' });

  table('Money in & out', [
    { header: 'Method', key: 'label', width: 16 }, { header: 'Sales', key: 'sales', width: 12, money: 1 }, { header: 'Credit collected', key: 'collections', width: 15, money: 1 },
    { header: 'Money in', key: 'moneyIn', width: 12, money: 1 }, { header: 'Refunds paid', key: 'refunds', width: 13, money: 1 }, { header: 'Expenses', key: 'expenses', width: 12, money: 1 },
    { header: 'Paid suppliers', key: 'suppliers', width: 14, money: 1 }, { header: 'Money out', key: 'moneyOut', width: 12, money: 1 }, { header: 'Net', key: 'net', width: 12, money: 1 },
  ], r.money.rows, { label: 'Total', moneyIn: r.money.moneyIn, moneyOut: r.money.moneyOut, net: r.money.net });

  table('Receivables', [
    { header: 'Name', key: 'name', width: 28 }, { header: 'ID no.', key: 'idNumber', width: 14 }, { header: 'Type', key: 'type', width: 10 },
    { header: 'Balance', key: 'balance', width: 12, money: 1 }, { header: 'Limit', key: 'limit', width: 12, money: 1 },
  ], r.receivables.accounts, { name: 'Total outstanding', balance: r.receivables.outstanding });

  table('Payables', [
    { header: 'Supplier', key: 'supplier', width: 28 }, { header: 'Unpaid deliveries', key: 'deliveries', width: 16 },
    { header: 'Owed', key: 'owed', width: 12, money: 1 }, { header: 'Overdue', key: 'overdue', width: 12, money: 1 },
  ], r.payables.suppliers, { supplier: 'Total', owed: r.payables.outstanding, overdue: r.payables.overdue });

  const dr = table('Cash drawer', [
    { header: 'Shift', key: 'shiftNo', width: 12 }, { header: 'Cashier', key: 'staff', width: 20 }, { header: 'Closed', key: 'closedAt', width: 18 },
    { header: 'Expected', key: 'expected', width: 12, money: 1 }, { header: 'Counted', key: 'counted', width: 12, money: 1 }, { header: 'Over / short', key: 'difference', width: 13, money: 1 },
  ], r.drawer.rows, { shiftNo: 'Total', expected: r.drawer.expected, counted: r.drawer.counted, difference: r.drawer.net });
  dr.getColumn('closedAt').numFmt = 'yyyy-mm-dd hh:mm';

  const j = table('Journal', [
    { header: 'Date', key: 'when', width: 18 }, { header: 'Type', key: 'type', width: 17 }, { header: 'Ref no.', key: 'ref', width: 14 },
    { header: 'Party', key: 'party', width: 22 }, { header: 'Method', key: 'method', width: 13 },
    { header: 'Money in', key: 'credit', width: 12, money: 1 }, { header: 'Money out', key: 'debit', width: 12, money: 1 }, { header: 'Note', key: 'note', width: 40 },
  ], r.journal.map((x) => ({ ...x, method: methodName(x.method) })));
  j.getColumn('when').numFmt = 'yyyy-mm-dd hh:mm';
  return wb;
}

const round = (n) => Math.round(n * 100) / 100;
const fmt = (n) => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function exportAccountingExcel(r) {
  const wb = await accountingWorkbook(r);
  const blob = new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `accounting-${r.period.from}_to_${r.period.to}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

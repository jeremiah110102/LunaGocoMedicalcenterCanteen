import { describe, it, expect } from 'vitest';
import { buildAccounting, drawerSummary, journal, moneyFlow, payables, receivables, salesBook } from '../src/lib/accounting';
import { accountingWorkbook } from '../src/services/accounting';
import { can } from '../src/lib/roles';

const at = (s) => new Date(`${s}T10:00`);
const sales = [
  { receiptNo: 'R-000001', total: 90, discount: 10, paymentMethod: 'cash', createdAt: at('2026-10-01'), cashierName: 'Ana', items: [{ cost: 40, qty: 1 }] },
  { receiptNo: 'R-000002', total: 50, discount: 0, paymentMethod: 'gcash', createdAt: at('2026-10-01'), items: [{ cost: 20, qty: 1 }] },
  { receiptNo: 'R-000003', total: 60, discount: 0, paymentMethod: 'credit', creditAccountName: 'Ben', createdAt: at('2026-10-03'), items: [{ cost: 25, qty: 1 }] },
];
const refunds = [{ refundNo: 'RF-000001', amount: 20, cashAmount: 20, gcashAmount: 0, creditAmount: 0, method: 'cash', createdAt: at('2026-10-03') }];
const payments = [{ accountName: 'Ben', amount: 30, method: 'cash', createdAt: at('2026-10-03') }, { accountName: 'Ben', amount: 10, method: 'gcash', createdAt: at('2026-10-03') }];
const expenses = [
  { date: '2026-10-02', category: 'Gas / LPG', amount: 15, method: 'cash', fromDrawer: true },
  { date: '2026-10-02', category: 'Other', amount: 99, method: 'cash', voided: true },
];
const supplierPayments = [{ paymentNo: 'SP-000001', supplierName: 'Metro', amount: 40, method: 'bank', paidAt: at('2026-10-02') }];
const from = new Date('2026-10-01T00:00');
const to = new Date('2026-10-03T23:59');

describe('sales book', () => {
  const b = salesBook({ sales, refunds, payments, expenses, supplierPayments, from, to });
  it('one row per day, gaps included', () => expect(b.rows.map((r) => r.period)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']));
  it('splits by method and nets refunds', () => {
    expect(b.rows[0]).toMatchObject({ receipts: 2, firstReceipt: 'R-000001', lastReceipt: 'R-000002', beforeDiscount: 150, discounts: 10, netSales: 140, cash: 90, gcash: 50 });
    expect(b.rows[2]).toMatchObject({ credit: 60, refunds: 20, netSales: 40, collections: 40 });
    expect(b.rows[1]).toMatchObject({ receipts: 0, expenses: 15, supplierPaid: 40 });
  });
  it('totals', () => expect(b.totals).toMatchObject({ receipts: 3, netSales: 180, expenses: 15 }));
  it('groups by month', () => expect(salesBook({ sales, from, to, by: 'month' }).rows).toEqual([expect.objectContaining({ period: '2026-10', receipts: 3, netSales: 200 })]));
});

describe('money in and out', () => {
  const m = moneyFlow({ sales, refunds, payments, expenses, supplierPayments });
  const row = (k) => m.rows.find((r) => r.method === k);
  it('cash: sales + collections − refunds − expenses', () => expect(row('cash')).toMatchObject({ moneyIn: 120, moneyOut: 35, net: 85 }));
  it('gcash and bank', () => {
    expect(row('gcash')).toMatchObject({ moneyIn: 60, net: 60 });
    expect(row('bank')).toMatchObject({ moneyOut: 40, net: -40 });
  });
  it('credit sales are not money', () => expect(row('credit')).toBeUndefined());
  it('totals', () => expect([m.moneyIn, m.moneyOut, m.net]).toEqual([180, 75, 105]));
});

describe('receivables and payables', () => {
  it('credit movement and who owes', () => {
    const r = receivables({ sales, refunds: [{ creditAmount: 5 }], payments, accounts: [{ name: 'Ben', balance: 15, type: 'student' }, { name: 'Cy', balance: 40, type: 'staff' }, { name: 'Di', balance: 0 }] });
    expect(r).toMatchObject({ creditSales: 60, collected: 40, creditRefunds: 5, netChange: 15, outstanding: 55, students: 15, staff: 40 });
    expect(r.accounts.map((a) => a.name)).toEqual(['Cy', 'Ben']);
  });
  it('owed and overdue by supplier', () => {
    const p = payables({
      deliveries: [{ total: 100 }],
      allDeliveries: [
        { supplierId: 'm', supplierName: 'Metro', total: 100, paidAmount: 40, dueDate: '2026-09-01' },
        { supplierId: 'm', supplierName: 'Metro', total: 50, paidAmount: 0, dueDate: '2026-12-01' },
        { supplierId: 'x', supplierName: 'Paid', total: 10, paidAmount: 10 },
      ],
      supplierPayments,
      today: new Date('2026-10-10T00:00'),
    });
    expect(p).toMatchObject({ billed: 100, paid: 40, outstanding: 110, overdue: 60 });
    expect(p.suppliers).toEqual([{ supplier: 'Metro', owed: 110, overdue: 60, deliveries: 2 }]);
  });
});

describe('cash drawer and journal', () => {
  it('over and short', () => {
    const d = drawerSummary([
      { status: 'closed', shiftNo: 'SH-1', expectedCash: 500, countedCash: 495, difference: -5, closedAt: at('2026-10-01') },
      { status: 'closed', shiftNo: 'SH-2', expectedCash: 300, countedCash: 302, difference: 2, closedAt: at('2026-10-02') },
      { status: 'open' },
    ]);
    expect(d).toMatchObject({ expected: 800, counted: 797, over: 2, short: 5, net: -3, open: 1 });
  });
  it('time order, voided expenses left out', () => {
    const j = journal({ sales, refunds, payments, expenses, supplierPayments });
    expect(j.length).toBe(8);
    expect(j[0].ref).toBe('R-000001');
    expect(j.filter((x) => x.type === 'Expense')).toHaveLength(1);
  });
});

describe('full report and Excel', () => {
  const r = buildAccounting({ sales, refunds, payments, expenses, supplierPayments, from, to, accounts: [{ name: 'Ben', balance: 20 }] });
  it('profit uses the P&L rules', () => expect(r.pl).toMatchObject({ grossSales: 200, refundTotal: 20, netSales: 180, cogs: 85, expenseTotal: 15, netProfit: 80 }));
  it('workbook has every sheet', async () => {
    const wb = await accountingWorkbook(r);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Daily sales book', 'Money in & out', 'Receivables', 'Payables', 'Cash drawer', 'Journal']);
    expect(wb.getWorksheet('Daily sales book').rowCount).toBe(5); // header + 3 days + total
    expect((await wb.xlsx.writeBuffer()).byteLength).toBeGreaterThan(5000);
  });
});

describe('accountant role', () => {
  const acct = { role: 'accountant', active: true };
  it('sees accounting, reports and sales only', () => {
    expect(['accounting', 'reports', 'sales', 'dashboard'].every((a) => can(acct, a))).toBe(true);
    expect(['pos', 'expenses', 'credit', 'products', 'users', 'settings', 'backup'].some((a) => can(acct, a))).toBe(false);
  });
});

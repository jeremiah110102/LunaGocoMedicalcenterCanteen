import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({
    user: { email: 'a@b.c', displayName: 'Ana Admin' },
    account: { id: 'uid1', role: 'admin', active: true, email: 'a@b.c' },
    approved: true,
    profile: { id: 's1', role: 'admin', active: true, displayName: 'Ana Admin', email: '' },
    staff: [
      { id: 's1', name: 'Ana Admin', role: 'admin', active: true },
      { id: 's2', name: 'Carlo Cruz', role: 'cashier', active: true },
    ],
    logout() {}, lock() {}, unlock() {}, changeOwnPin() {}, createFirstAdmin() {},
    loginEmail() {}, loginGoogle() {}, register() {}, resetPassword() {},
  }),
  AuthProvider: ({ children }) => children,
}));

const pages = ['Dashboard', 'POS', 'Sales', 'Products', 'Ingredients', 'Inventory', 'Credit', 'Reports', 'Users', 'Backup', 'AuditLog', 'Login', 'Pending', 'PinLock', 'SetupAdmin', 'Purchasing', 'Settings', 'Shifts', 'Expenses', 'Accounting'];
const { ToastProvider } = await import('../src/components/ui');
const { Receipt } = await import('../src/components/Receipt');
const Layout = (await import('../src/components/Layout')).default;
const ChangePin = (await import('../src/components/ChangePin')).default;

describe('pages render', () => {
  for (const name of pages) {
    it(name, async () => {
      const C = (await import(`../src/pages/${name}.jsx`)).default;
      const html = renderToString(<MemoryRouter><ToastProvider><C /></ToastProvider></MemoryRouter>);
      expect(html.length).toBeGreaterThan(50);
    });
  }
  it('layout', () => expect(renderToString(<MemoryRouter><Layout /></MemoryRouter>)).toContain('Backup &amp; restore'));
  it('received deliveries tab', async () => {
    const { Deliveries } = await import('../src/pages/Deliveries.jsx');
    const html = renderToString(<MemoryRouter><ToastProvider><Deliveries suppliers={[{ id: 'x', name: 'Metro' }]} items={[]} onOpenPO={() => {}} /></ToastProvider></MemoryRouter>);
    expect(html).toContain('Record delivery without PO');
  });
  it('new dialogs and tabs render', async () => {
    const wrap = (el) => renderToString(<MemoryRouter><ToastProvider>{el}</ToastProvider></MemoryRouter>);
    const sale = { id: 's1', receiptNo: 'R-000009', items: [{ productId: 'a', name: 'Adobo', price: 65, qty: 2, cost: 30, modifiers: [{ name: 'Egg', price: 15 }] }], subtotal: 130, total: 130, discount: 0, paymentMethod: 'cash', tendered: 200, change: 70, cashierName: 'Ana', createdAt: new Date(), refundedTotal: 0 };
    const RefundModal = (await import('../src/components/RefundModal.jsx')).default;
    expect(wrap(<RefundModal sale={sale} onClose={() => {}} />)).toContain('Manager approval');
    const { KitchenSlip } = await import('../src/components/Receipt.jsx');
    expect(wrap(<KitchenSlip sale={sale} />)).toContain('KITCHEN ORDER');
    const D = await import('../src/pages/Deliveries.jsx');
    expect(wrap(<D.Payables suppliers={[{ id: 'x', name: 'Metro' }]} />)).toContain('Owed to suppliers');
    const X = await import('../src/pages/InventoryExtras.jsx');
    expect(wrap(<X.StockCounts items={[]} />)).toContain('Start count');
    expect(wrap(<X.Expiring batches={[{ id: 'b', name: 'Egg', expiryDate: '2020-01-01', qty: 5, unit: 'pc', status: 'open', deliveryNo: 'DR-1' }]} />)).toContain('Expired');
    const C = await import('../src/pages/CreditExtras.jsx');
    const acct = { id: 'a1', name: 'Ben', idNumber: '2026-1', type: 'student', balance: 50, limit: 100 };
    expect(wrap(<C.StatementModal account={acct} sales={[]} refunds={[]} payments={[]} onClose={() => {}} />)).toContain('Balance due');
    expect(wrap(<C.QrCards accounts={[acct]} onClose={() => {}} />)).toContain('2026-1');
    const IE = (await import('../src/components/InventoryExport.jsx')).default;
    expect(wrap(<IE />)).toContain('Export PDF');
    const { CameraScanner } = await import('../src/components/Scanning.jsx');
    expect(wrap(<CameraScanner continuous onDetected={() => {}} onClose={() => {}} />)).toContain('Keeps scanning');
    const S = await import('../src/pages/SettingsExtras.jsx');
    expect(wrap(<S.PrinterSettings />)).toContain('Paper width');
  });
  it('change PIN dialog', () => expect(renderToString(<ToastProvider><ChangePin onClose={() => {}} /></ToastProvider>)).toContain('Current PIN'));
  it('receipt', () => {
    const html = renderToString(<Receipt sale={{ receiptNo: 'R-000001', createdAt: new Date(), cashierName: 'Ana', items: [{ name: 'Adobo rice', qty: 2, price: 60, lineTotal: 120 }], subtotal: 120, discount: 12, discountType: 'percent', discountValue: 10, total: 108, paymentMethod: 'cash', tendered: 200, change: 92 }} />);
    expect(html).toContain('R-000001');
    expect(html).toContain('92.00');
  });
});

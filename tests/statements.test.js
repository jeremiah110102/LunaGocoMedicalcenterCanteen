import { describe, it, expect } from 'vitest';
import { buildStatement } from '../src/lib/statements';

describe('credit statement', () => {
  const d = (s) => new Date(s);
  const st = buildStatement({
    sales: [{ createdAt: d('2026-09-28T10:00'), receiptNo: 'R-1', total: 100, items: [] }, { createdAt: d('2026-10-03T10:00'), receiptNo: 'R-2', total: 60, items: [{ qty: 1, name: 'Adobo' }] }],
    refunds: [{ createdAt: d('2026-10-04T10:00'), refundNo: 'RF-1', creditAmount: 20, receiptNo: 'R-2' }, { createdAt: d('2026-10-04T11:00'), refundNo: 'RF-2', creditAmount: 0 }],
    payments: [{ createdAt: d('2026-10-05T10:00'), method: 'payroll', amount: 90 }],
    from: d('2026-10-01T00:00'), to: d('2026-10-31T23:59'),
  });
  it('carries the opening balance and runs a balance', () => {
    expect([st.opening, st.purchases, st.credits, st.closing]).toEqual([100, 60, 110, 50]);
    expect(st.lines.map((l) => l.balance)).toEqual([160, 140, 50]);
    expect(st.lines[2].ref).toBe('Payroll');
  });
});

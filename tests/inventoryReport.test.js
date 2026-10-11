import { describe, it, expect } from 'vitest';
import { buildInventoryReport, inventoryWorkbook, inventoryPdf } from '../src/services/inventoryReport';

const r = buildInventoryReport({
  products: [
    { id: 'p1', name: 'Coke', trackStock: true, stock: 3, lowStock: 5, cost: 18, unit: 'bottle', categoryId: 'c1' },
    { id: 'p2', name: 'Gum', trackStock: true, stock: -2, lowStock: 2, cost: 3 },
    { id: 'p3', name: 'Adobo', trackStock: false },
  ],
  ingredients: [{ id: 'i1', name: 'Rice', stock: 20, lowStock: 5, cost: 50, unit: 'kg' }],
  categories: [{ id: 'c1', name: 'Drinks' }],
  movements: [
    { itemType: 'product', itemId: 'p1', itemName: 'Coke', change: -2, stockAfter: 3, reason: 'sale', createdAt: new Date('2026-10-10T10:00') },
    { itemType: 'ingredient', itemId: 'i1', itemName: 'Rice', change: 10, stockAfter: 20, reason: 'receive', createdAt: new Date('2026-10-10T08:00') },
  ],
  batches: [{ name: 'Egg', qty: 30, expiryDate: '2026-10-13', status: 'open', deliveryNo: 'DR-1' }],
  from: new Date('2026-10-01'), to: new Date('2026-10-11'), today: new Date(2026, 9, 11),
});

describe('inventory report', () => {
  it('summarises stock, status and value', () => {
    expect(r.summary).toMatchObject({ items: 3, low: 1, out: 1, negative: 1, expiring: 1, value: 54 + 1000, received: 10, used: 2 });
    expect(r.attention.map((i) => [i.name, i.status])).toEqual([['Gum', 'Out of stock'], ['Coke', 'Low']]);
    expect(r.items.find((i) => i.name === 'Coke').category).toBe('Drinks');
    expect(r.log.map((m) => m.reason)).toEqual(['Received', 'Sale']);
  });
  it('writes an Excel workbook with every sheet', async () => {
    const wb = await inventoryWorkbook(r);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Stock levels', 'Low & out of stock', 'Expiring', 'Consumption & waste', 'Movements']);
    expect(wb.getWorksheet('Stock levels').rowCount).toBe(4);
    expect((await wb.xlsx.writeBuffer()).byteLength).toBeGreaterThan(5000);
  });
  it('writes a PDF', async () => {
    const pdf = await inventoryPdf(r);
    const out = pdf.output('arraybuffer');
    expect(new TextDecoder().decode(out.slice(0, 5))).toBe('%PDF-');
    expect(pdf.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });
});

import { describe, it, expect } from 'vitest';
import { mapHeaders, planImport } from '../src/lib/productImport';

const products = [
  { id: 'p1', name: 'Coke Mismo', sku: 'CK1', barcode: '4800888', categoryId: 'c1', price: 25 },
  { id: 'p2', name: 'Adobo Rice', price: 60 },
];
const categories = [{ id: 'c1', name: 'Drinks' }];

describe('product import', () => {
  it('reads the template headers', () => {
    expect(mapHeaders(['Name *', 'Selling price', 'Track stock', 'Whatever'])).toEqual(['name', 'price', 'trackStock', null]);
  });
  it('creates, updates and validates', () => {
    const plan = planImport([
      { line: 2, name: 'Sprite', category: 'Drinks', type: 'Drink', price: '₱25', cost: 18, trackStock: 'Yes', stock: 24, barcode: '4800999' },
      { line: 3, name: 'coke mismo', price: 27, stock: 10 }, // matches by name → update, stock ignored
      { line: 4, name: 'Turon', category: 'Snacks', price: 15 }, // new category
      { line: 5, name: '', price: '' }, // blank row skipped
      { line: 6, name: 'Bad', price: 'abc', type: 'Pizza' },
      { line: 7, name: 'Dup', price: 5, barcode: '4800888' }, // barcode of another product
      { line: 8, name: 'Sprite', price: 25 }, // same name as row 2
    ], { products, categories });
    expect(plan.items.map((i) => [i.line, i.action])).toEqual([[2, 'create'], [3, 'update'], [4, 'create']]);
    expect(plan.items[0]).toMatchObject({ categoryId: 'c1', openingStock: 24, data: { price: 25, trackStock: true, type: 'drink' } });
    expect(plan.items[1]).toMatchObject({ existingId: 'p1', data: { price: 27 } });
    expect(plan.items[1].warnings[0]).toMatch(/Opening stock ignored/);
    expect(plan.newCategories).toEqual(['Snacks']);
    expect(plan.errors).toHaveLength(3);
    expect(plan.errors.join(' ')).toMatch(/Row 6: Selling price.*Type "Pizza"/);
    expect(plan.errors.join(' ')).toMatch(/Row 7: Updates the same product \(Coke Mismo\) as row 3/);
    expect(plan.errors.join(' ')).toMatch(/Row 8: Same name as row 2/);
  });
});

import { buildProductTemplate, readProductFile } from '../src/services/productImport';
describe('Excel template round trip', () => {
  it('the downloaded template imports back correctly', async () => {
    const wb = await buildProductTemplate([{ id: 'c1', name: 'Drinks' }]);
    const ws = wb.getWorksheet('Products');
    ws.addRow({ name: 'Mango Juice', category: 'Drinks', type: 'Drink', price: 30, trackStock: 'Yes', stock: 12, barcode: '4800000000017' });
    const file = new File([await wb.xlsx.writeBuffer()], 'filled.xlsx');
    const plan = await readProductFile(file, { products: [], categories: [{ id: 'c1', name: 'Drinks' }] });
    expect(plan.errors).toEqual([]);
    expect(plan.items.map((i) => i.data.name)).toEqual(['Chicken Adobo w/ Rice', 'Coke Mismo 290ml', 'Piattos Cheese 40g', 'Mango Juice']);
    expect(plan.items[3]).toMatchObject({ action: 'create', categoryId: 'c1', openingStock: 12, data: { barcode: '4800000000017', trackStock: true } });
    expect(plan.newCategories.sort()).toEqual(['Rice meals', 'Snacks']);
  });
  it('reads a CSV too', async () => {
    const file = new File(['Name,Selling price,Track stock,Opening stock\n"Pandesal, 5 pcs",25,Yes,40\n'], 'p.csv');
    const plan = await readProductFile(file, { products: [], categories: [] });
    expect(plan.items[0]).toMatchObject({ data: { name: 'Pandesal, 5 pcs', price: 25 }, openingStock: 40 });
  });
});

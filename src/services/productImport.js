import { db, batchSize, collection, doc, serverTimestamp, writeBatch } from '../db';
import { IMPORT_COLUMNS, mapHeaders, planImport } from '../lib/productImport';
import { cellToValue } from '../lib/backupFormat';
import { logAudit } from '../lib/audit';

const loadExcel = async () => (await import('exceljs')).default;

function download(buf, name) {
  const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Excel template with headers, examples, drop-downs, the category list, and instructions. */
export async function downloadProductTemplate(categories = []) {
  const wb = await buildProductTemplate(categories);
  download(await wb.xlsx.writeBuffer(), 'canteen-products-template.xlsx');
}

export async function buildProductTemplate(categories = []) {
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Products', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = IMPORT_COLUMNS.map((c) => ({ header: c.required ? `${c.header} *` : c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F5E46' } };
  IMPORT_COLUMNS.forEach((c, i) => {
    head.getCell(i + 1).note = c.note;
  });
  ws.addRows([
    { name: 'Chicken Adobo w/ Rice', category: 'Rice meals', type: 'Meal', price: 65, cost: 38, unit: 'plate', trackStock: 'No', lowStock: 0 },
    { name: 'Coke Mismo 290ml', category: 'Drinks', type: 'Drink', price: 25, cost: 18, unit: 'bottle', sku: 'CK290', barcode: '4801981116017', trackStock: 'Yes', stock: 48, lowStock: 12 },
    { name: 'Piattos Cheese 40g', category: 'Snacks', type: 'Snack', price: 20, cost: 15, unit: 'pack', barcode: '4800016644313', trackStock: 'Yes', stock: 30, lowStock: 10 },
  ]);
  ws.getRows(2, 3).forEach((r) => (r.font = { italic: true, color: { argb: 'FF8E877B' } }));
  // Drop-downs for 1,000 rows
  const typeCol = IMPORT_COLUMNS.findIndex((c) => c.key === 'type') + 1;
  const trackCol = IMPORT_COLUMNS.findIndex((c) => c.key === 'trackStock') + 1;
  for (let r = 2; r <= 1000; r++) {
    ws.getCell(r, typeCol).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Meal,Snack,Drink,Other"'] };
    ws.getCell(r, trackCol).dataValidation = { type: 'list', allowBlank: true, formulae: ['"Yes,No"'] };
  }

  const cats = wb.addWorksheet('Categories');
  cats.columns = [{ header: 'Existing categories (type any new name to create one)', key: 'name', width: 50 }];
  cats.getRow(1).font = { bold: true };
  categories.map((c) => c.name).sort().forEach((name) => cats.addRow({ name }));

  const help = wb.addWorksheet('How to');
  help.columns = [{ width: 110 }];
  [
    'HOW TO IMPORT PRODUCTS',
    '',
    '1. Fill in the "Products" sheet: one product per row. Delete the 3 grey example rows (or keep them if you want them).',
    '2. Required: Name and Selling price. Everything else is optional.',
    '3. Existing products are UPDATED when the SKU, the barcode, or the exact name matches. Other rows become NEW products.',
    '4. Opening stock is only used for new products with Track stock = Yes. To change stock of existing products, use Inventory.',
    '5. Categories that don\'t exist yet are created automatically.',
    '6. Save the file, then in the app: Products → Import from Excel → choose the file → check the preview → Import.',
    '',
    'Columns:',
    ...IMPORT_COLUMNS.map((c) => `  ${c.header}${c.required ? ' (required)' : ''}: ${c.note}`),
  ].forEach((t, i) => {
    const row = help.addRow([t]);
    if (i === 0) row.font = { bold: true, size: 14 };
  });
  return wb;
}

/** Reads an .xlsx/.csv file into rows and checks them. Does not save anything. */
export async function readProductFile(file, { products, categories }) {
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  try {
    if (/\.csv$/i.test(file.name)) {
      const text = await file.text();
      const ws = wb.addWorksheet('Products');
      text.split(/\r?\n/).filter((l) => l.trim()).forEach((line) => ws.addRow(parseCsvLine(line)));
    } else {
      await wb.xlsx.load(await file.arrayBuffer());
    }
  } catch {
    return { items: [], errors: ['The file could not be opened. Use the Excel template (.xlsx) or a .csv file.'], newCategories: [] };
  }
  const ws = wb.getWorksheet('Products') || wb.worksheets[0];
  if (!ws) return { items: [], errors: ['The file has no sheets.'], newCategories: [] };
  const headerRow = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, col) => (headerRow[col - 1] = cellToValue(c.value)));
  const keys = mapHeaders(headerRow);
  if (!keys.includes('name') || !keys.includes('price')) {
    return { items: [], errors: ['The first row must have the column headers from the template (at least "Name" and "Selling price").'], newCategories: [] };
  }
  const rows = [];
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const r = { line: i };
    keys.forEach((k, col) => {
      if (k) r[k] = cellToValue(row.getCell(col + 1).value);
    });
    rows.push(r);
  });
  return planImport(rows, { products, categories });
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Saves a checked import plan: new categories, new products (with opening stock), updates. */
export async function runProductImport(plan, profile, onProgress = () => {}) {
  const catIds = {};
  const ops = [];
  for (const name of plan.newCategories) {
    const ref = doc(collection(db, 'categories'));
    catIds[name.toLowerCase()] = ref.id;
    ops.push((b) => b.set(ref, { name, createdAt: serverTimestamp() }));
  }
  let created = 0;
  let updated = 0;
  for (const it of plan.items) {
    const categoryId = it.categoryName ? catIds[it.categoryName.toLowerCase()] : it.categoryId;
    if (it.action === 'create') {
      const ref = doc(collection(db, 'products'));
      const stock = it.openingStock || 0;
      ops.push((b) => b.set(ref, { ...it.data, categoryId: categoryId || '', recipe: [], modifiers: [], components: [], stock, soldOut: false, archived: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
      if (stock > 0) {
        ops.push((b) => b.set(doc(collection(db, 'stockMovements')), {
          itemType: 'product', itemId: ref.id, itemName: it.data.name, change: stock, stockAfter: stock,
          reason: 'initial', note: 'Opening stock (Excel import)', byId: profile.id, byName: profile.displayName || '', createdAt: serverTimestamp(),
        }));
      }
      created++;
    } else {
      ops.push((b) => b.update(doc(db, 'products', it.existingId), { ...it.data, ...(categoryId ? { categoryId } : {}), updatedAt: serverTimestamp() }));
      updated++;
    }
  }
  const size = batchSize(db);
  for (let i = 0; i < ops.length; i += size) {
    const b = writeBatch(db);
    ops.slice(i, i + size).forEach((op) => op(b));
    await b.commit();
    onProgress(Math.min(i + size, ops.length), ops.length);
  }
  await logAudit(profile, 'product.import', { created, updated, newCategories: plan.newCategories });
  return { created, updated, categories: plan.newCategories.length };
}

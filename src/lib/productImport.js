// Checks rows from the product import template. Pure, so it can be unit-tested.
import { round2 } from './checkout';

export const IMPORT_COLUMNS = [
  { key: 'name', header: 'Name', required: true, width: 28, note: 'Product name as shown on the cashier screen' },
  { key: 'category', header: 'Category', width: 18, note: 'New categories are created automatically' },
  { key: 'type', header: 'Type', width: 12, note: 'Meal, Snack, Drink or Other' },
  { key: 'price', header: 'Selling price', required: true, width: 14, note: 'Pesos, e.g. 45 or 12.50' },
  { key: 'cost', header: 'Cost', width: 10, note: 'Your cost per unit (for profit reports)' },
  { key: 'unit', header: 'Unit', width: 10, note: 'pc, bottle, plate, pack…' },
  { key: 'sku', header: 'SKU', width: 14, note: 'Optional short code, must be unique' },
  { key: 'barcode', header: 'Barcode', width: 18, note: 'Optional; scan or type the number on the package' },
  { key: 'trackStock', header: 'Track stock', width: 12, note: 'Yes for packed drinks/snacks, No for cooked food' },
  { key: 'stock', header: 'Opening stock', width: 14, note: 'Only used for NEW products that track stock' },
  { key: 'lowStock', header: 'Low-stock alert', width: 15, note: 'Warn when stock drops to this number' },
];

const TYPES = { meal: 'meal', meals: 'meal', snack: 'snack', snacks: 'snack', drink: 'drink', drinks: 'drink', beverage: 'drink', other: 'other' };
const YES = ['yes', 'y', 'true', '1', 'oo', 'track'];
const NO = ['no', 'n', 'false', '0', 'hindi', ''];
const norm = (v) => String(v ?? '').trim();
const low = (v) => norm(v).toLowerCase();

/** Maps a header row to column keys (accepts the template headers, or the keys themselves). */
export function mapHeaders(headerRow) {
  return headerRow.map((h) => {
    const t = low(h).replace(/\s*\*$/, '');
    const col = IMPORT_COLUMNS.find((c) => low(c.header) === t || c.key.toLowerCase() === t);
    return col ? col.key : null;
  });
}

const num = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[₱,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

/**
 * rows: [{ line, name, category, … }] (raw cell values)
 * products/categories: what already exists.
 * Returns { items: [{ line, action: 'create'|'update', data, existingId, warnings }], errors: [string], newCategories: [name] }
 */
export function planImport(rows, { products, categories }) {
  const errors = [];
  const items = [];
  const catByName = new Map(categories.map((c) => [low(c.name), c]));
  const newCategories = new Set();
  const seen = { sku: new Map(), barcode: new Map(), name: new Map() };
  const matched = new Map(); // existing product id → row that updates it

  for (const r of rows) {
    const e = [];
    const warnings = [];
    const name = norm(r.name);
    if (!name) {
      if (Object.values(r).some((v) => norm(v) && v !== r.line)) e.push('Name is missing');
      else continue; // blank row
    }
    const price = num(r.price);
    if (price === null || Number.isNaN(price) || price < 0) e.push('Selling price must be a number (0 or more)');
    const cost = num(r.cost);
    if (Number.isNaN(cost) || (cost !== null && cost < 0)) e.push('Cost must be a number');
    const stock = num(r.stock);
    if (Number.isNaN(stock)) e.push('Opening stock must be a number');
    const lowStock = num(r.lowStock);
    if (Number.isNaN(lowStock)) e.push('Low-stock alert must be a number');
    const typeRaw = low(r.type);
    const type = typeRaw ? TYPES[typeRaw] : 'meal';
    if (!type) e.push(`Type "${r.type}" is not Meal, Snack, Drink or Other`);
    const trackRaw = low(r.trackStock);
    let trackStock = null;
    if (YES.includes(trackRaw)) trackStock = true;
    else if (NO.includes(trackRaw)) trackStock = trackRaw === '' ? null : false;
    else e.push(`Track stock "${r.trackStock}" should be Yes or No`);

    const sku = norm(r.sku).toUpperCase();
    const barcode = norm(r.barcode);
    for (const [k, v] of [['sku', sku], ['barcode', barcode], ['name', low(name)]]) {
      if (!v) continue;
      if (seen[k].has(v)) e.push(`Same ${k === 'name' ? 'name' : k.toUpperCase()} as row ${seen[k].get(v)}`);
      else seen[k].set(v, r.line);
    }

    // Match an existing product: SKU, then barcode, then exact name
    const existing =
      (sku && products.find((p) => norm(p.sku).toUpperCase() === sku)) ||
      (barcode && products.find((p) => norm(p.barcode) === barcode)) ||
      products.find((p) => low(p.name) === low(name)) ||
      null;
    if (existing && matched.has(existing.id)) e.push(`Updates the same product (${existing.name}) as row ${matched.get(existing.id)}`);
    else if (existing) matched.set(existing.id, r.line);
    if (sku && products.some((p) => p !== existing && norm(p.sku).toUpperCase() === sku)) e.push(`SKU ${sku} belongs to another product`);
    if (barcode && products.some((p) => p !== existing && norm(p.barcode) === barcode)) e.push(`Barcode ${barcode} belongs to another product`);

    const catName = norm(r.category);
    let categoryId = existing?.categoryId || '';
    let categoryName = '';
    if (catName) {
      const c = catByName.get(low(catName));
      if (c) categoryId = c.id;
      else {
        newCategories.add(catName);
        categoryName = catName;
        categoryId = '';
      }
    }

    if (e.length) {
      errors.push(`Row ${r.line}: ${e.join('; ')}`);
      continue;
    }

    const data = {
      name,
      price: round2(price),
      ...(cost !== null ? { cost: round2(cost) } : {}),
      ...(type ? { type } : {}),
      ...(norm(r.unit) ? { unit: norm(r.unit) } : {}),
      ...(sku ? { sku } : {}),
      ...(barcode ? { barcode } : {}),
      ...(trackStock !== null ? { trackStock } : {}),
      ...(lowStock !== null ? { lowStock } : {}),
    };
    if (existing) {
      if (stock !== null) warnings.push('Opening stock ignored for an existing product — use Inventory to change stock');
      items.push({ line: r.line, action: 'update', existingId: existing.id, existingName: existing.name, data, categoryId, categoryName, warnings });
    } else {
      const track = trackStock ?? (stock !== null && stock > 0);
      if (stock !== null && stock > 0 && trackStock === false) warnings.push('Opening stock ignored because Track stock is No');
      items.push({
        line: r.line,
        action: 'create',
        data: { unit: 'pc', cost: 0, lowStock: 5, type: 'meal', ...data, trackStock: track },
        openingStock: track && stock > 0 ? round2(stock) : 0,
        categoryId,
        categoryName,
        warnings,
      });
    }
  }
  return { items, errors, newCategories: [...newCategories] };
}

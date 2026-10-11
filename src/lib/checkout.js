// Pure checkout logic — no Firebase here, so it can be unit-tested.

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export const PAYMENT_METHODS = { cash: 'Cash', gcash: 'GCash', credit: 'Credit' };

/** discount: { type: 'none' | 'percent' | 'amount', value } */
export function computeTotals(lines, discount = { type: 'none', value: 0 }) {
  const subtotal = round2(lines.reduce((s, l) => s + Number(l.price) * Number(l.qty), 0));
  const v = Math.max(Number(discount?.value) || 0, 0);
  let d = 0;
  if (discount?.type === 'percent') d = (subtotal * Math.min(v, 100)) / 100;
  else if (discount?.type === 'amount') d = Math.min(v, subtotal);
  d = round2(d);
  return { subtotal, discount: d, total: round2(subtotal - d) };
}

/**
 * Returns { ok, error, change } for a payment attempt.
 * account: credit account doc ({ active, balance, limit }) for credit sales.
 */
export function validatePayment({ method, total, tendered, reference, account }) {
  if (!(total > 0)) return { ok: false, error: 'Cart is empty.' };
  if (method === 'cash') {
    const t = Number(tendered);
    if (!Number.isFinite(t) || t <= 0) return { ok: false, error: 'Enter the cash amount received.' };
    if (round2(t) < total) return { ok: false, error: 'Cash received is less than the total.' };
    return { ok: true, change: round2(t - total) };
  }
  if (method === 'gcash') {
    if (!String(reference || '').trim()) return { ok: false, error: 'Enter the GCash reference number.' };
    return { ok: true, change: 0 };
  }
  if (method === 'credit') {
    if (!account) return { ok: false, error: 'Choose a credit account.' };
    if (account.active === false) return { ok: false, error: 'This credit account is disabled.' };
    const limit = Number(account.limit) || 0;
    const after = round2((Number(account.balance) || 0) + total);
    if (after > limit) {
      const available = round2(Math.max(limit - (Number(account.balance) || 0), 0));
      return { ok: false, error: `Over credit limit. Available credit: ${available.toFixed(2)}.` };
    }
    return { ok: true, change: 0 };
  }
  return { ok: false, error: 'Choose a payment method.' };
}

/* ---------------- add-ons and meal sets ----------------
 * product.modifiers  = [{ name, price, recipe: [{ ingredientId, qty }] }]   (add-ons, e.g. "Extra rice")
 * product.type 'combo' + product.components = [{ productId, qty }]          (meal sets)
 * Cart line: { key, productId, name, price, qty, modifiers: ['Extra rice', …] }
 */

export const lineKey = (productId, modifiers = []) => [productId, ...[...modifiers].sort()].join('|');

/** Unit price of a product with chosen add-ons, from the product record. */
export function linePricing(product, modifierNames = []) {
  const chosen = [];
  for (const name of modifierNames) {
    const m = (product.modifiers || []).find((x) => x.name === name);
    if (!m) return { error: `${product.name}: add-on "${name}" is no longer offered` };
    chosen.push({ name: m.name, price: round2(Number(m.price) || 0) });
  }
  const unitPrice = round2((Number(product.price) || 0) + chosen.reduce((t, m) => t + m.price, 0));
  return { unitPrice, modifiers: chosen };
}

/** Product ids that must also be read for a cart (meal-set components). */
export function componentIds(productsById) {
  const ids = new Set();
  for (const p of Object.values(productsById)) {
    if (p?.type === 'combo') for (const c of p.components || []) if (!productsById[c.productId]) ids.add(c.productId);
  }
  return [...ids];
}

/**
 * How much of each product and ingredient a cart uses.
 * Stock-tracked products deduct themselves; recipes deduct ingredients; add-ons deduct their
 * own ingredients; meal sets deduct each component (and the components' recipes).
 */
export function computeStockNeeds(lines, productsById) {
  const products = {};
  const ingredients = {};
  const addIng = (recipe, mult) => {
    for (const r of recipe || []) {
      if (!r.ingredientId || !(Number(r.qty) > 0)) continue;
      ingredients[r.ingredientId] = round2((ingredients[r.ingredientId] || 0) + Number(r.qty) * mult);
    }
  };
  const addProduct = (p, mult, depth = 0) => {
    if (!p) return;
    if (p.trackStock) products[p.id] = round2((products[p.id] || 0) + mult);
    addIng(p.recipe, mult);
    if (p.type === 'combo' && depth === 0) {
      for (const c of p.components || []) addProduct(productsById[c.productId], mult * (Number(c.qty) || 1), 1);
    }
  };
  for (const line of lines) {
    const p = productsById[line.productId];
    if (!p) continue;
    const mult = Number(line.qty);
    addProduct(p, mult);
    for (const name of line.modifiers || []) addIng((p.modifiers || []).find((m) => m.name === name)?.recipe, mult);
  }
  return { products, ingredients };
}

/** Returns a list of human-readable shortage messages (empty when everything is available). */
export function findShortages(needs, productsById, ingredientsById) {
  const out = [];
  for (const [id, need] of Object.entries(needs.products)) {
    const p = productsById[id];
    const have = Number(p?.stock) || 0;
    if (have < need) out.push(`${p?.name || 'Product'}: need ${need}, only ${have} in stock`);
  }
  for (const [id, need] of Object.entries(needs.ingredients)) {
    const i = ingredientsById[id];
    if (!i) {
      out.push('A recipe uses an ingredient that no longer exists');
      continue;
    }
    const have = Number(i.stock) || 0;
    if (have < need) out.push(`${i.name}: need ${need} ${i.unit || ''}, only ${have} left`.trim());
  }
  return out;
}

/** Checks each cart line against the current product record (and meal-set components). */
export function findUnavailable(lines, productsById) {
  const out = [];
  for (const line of lines) {
    const p = productsById[line.productId];
    if (!p) out.push(`${line.name}: product no longer exists`);
    else if (p.archived) out.push(`${p.name}: product is archived`);
    else if (p.soldOut) out.push(`${p.name}: marked sold out`);
    else if (!(Number(line.qty) > 0) || !Number.isInteger(Number(line.qty))) out.push(`${p.name}: invalid quantity`);
    else if (p.type === 'combo') {
      for (const c of p.components || []) {
        const comp = productsById[c.productId];
        if (!comp || comp.archived) out.push(`${p.name}: a meal-set item no longer exists`);
        else if (comp.soldOut) out.push(`${p.name}: ${comp.name} is sold out`);
      }
    }
  }
  return out;
}

/** How many of a product can still be made/sold from current stock (Infinity when untracked). */
export function availableCount(product, ingredientsById, productsById = {}, depth = 0) {
  if (!product) return 0;
  let n = product.trackStock ? Math.floor(Number(product.stock) || 0) : Infinity;
  for (const r of product.recipe || []) {
    const ing = ingredientsById[r.ingredientId];
    if (!ing || !(Number(r.qty) > 0)) continue;
    n = Math.min(n, Math.floor((Number(ing.stock) || 0) / Number(r.qty)));
  }
  if (product.type === 'combo' && depth === 0) {
    for (const c of product.components || []) {
      const comp = productsById[c.productId];
      if (!comp || comp.soldOut || comp.archived) return 0;
      n = Math.min(n, Math.floor(availableCount(comp, ingredientsById, productsById, 1) / (Number(c.qty) || 1)));
    }
  }
  return n;
}

export const receiptNumber = (n) => `R-${String(n).padStart(6, '0')}`;

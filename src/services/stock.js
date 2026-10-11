import { db, collection, doc, serverTimestamp } from '../db';
import { componentIds, computeStockNeeds, round2 } from '../lib/checkout';

/**
 * Reads (inside a transaction) the products in `productIds`, any meal-set components,
 * and the ingredients the given cart lines need. Returns lookups plus the stock needs.
 */
export async function readForLines(tx, lines) {
  const productsById = {};
  const readProducts = async (ids) => {
    const snaps = await Promise.all(ids.map((id) => tx.get(doc(db, 'products', id))));
    snaps.forEach((s, i) => {
      if (s.exists()) productsById[ids[i]] = { id: ids[i], ...s.data() };
    });
  };
  await readProducts([...new Set(lines.map((l) => l.productId))]);
  const comps = componentIds(productsById);
  if (comps.length) await readProducts(comps);

  const needs = computeStockNeeds(lines, productsById);
  const ingIds = Object.keys(needs.ingredients);
  const ingSnaps = await Promise.all(ingIds.map((id) => tx.get(doc(db, 'ingredients', id))));
  const ingredientsById = {};
  ingSnaps.forEach((s, i) => {
    if (s.exists()) ingredientsById[ingIds[i]] = { id: ingIds[i], ...s.data() };
  });
  return { productsById, ingredientsById, needs };
}

/**
 * Writes stock changes for `needs` (sign -1 = take out, +1 = put back) with a stock
 * movement per item. With clamp, stock never goes below zero and shortfalls are returned.
 */
export function applyStock(tx, { needs, productsById, ingredientsById }, { sign, reason, note, extra = {}, profile, clamp = false }) {
  const shortfalls = [];
  const one = (itemType, col, item, qty) => {
    if (!item) return;
    const have = Number(item.stock) || 0;
    let change = round2(sign * qty);
    if (clamp && have + change < 0) {
      shortfalls.push(`${item.name}: needed ${qty}, had ${have}`);
      change = round2(-have);
    }
    const after = round2(have + change);
    tx.update(doc(db, col, item.id), { stock: after, updatedAt: serverTimestamp() });
    tx.set(doc(collection(db, 'stockMovements')), {
      itemType,
      itemId: item.id,
      itemName: item.name,
      change,
      stockAfter: after,
      reason,
      note,
      ...extra,
      byId: profile.id,
      byName: profile.displayName || '',
      createdAt: serverTimestamp(),
    });
  };
  for (const [id, q] of Object.entries(needs.products)) one('product', 'products', productsById[id], q);
  for (const [id, q] of Object.entries(needs.ingredients)) one('ingredient', 'ingredients', ingredientsById[id], q);
  return shortfalls;
}

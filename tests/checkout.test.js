import { describe, it, expect } from 'vitest';
import {
  computeTotals,
  validatePayment,
  computeStockNeeds,
  findShortages,
  findUnavailable,
  availableCount,
} from '../src/lib/checkout';

const products = {
  rice: { id: 'rice', name: 'Chicken Rice', price: 60, trackStock: false, recipe: [{ ingredientId: 'chk', qty: 0.15 }, { ingredientId: 'rc', qty: 1 }] },
  coke: { id: 'coke', name: 'Coke', price: 25, trackStock: true, stock: 3 },
  old: { id: 'old', name: 'Old Item', price: 10, archived: true },
  out: { id: 'out', name: 'Sold Out Item', price: 10, soldOut: true },
};
const ingredients = {
  chk: { id: 'chk', name: 'Chicken', unit: 'kg', stock: 0.4 },
  rc: { id: 'rc', name: 'Rice cup', unit: 'cup', stock: 10 },
};

describe('computeTotals', () => {
  const lines = [{ price: 60, qty: 2 }, { price: 25, qty: 1 }];
  it('adds up the subtotal', () => expect(computeTotals(lines).total).toBe(145));
  it('applies a percent discount', () => expect(computeTotals(lines, { type: 'percent', value: 10 })).toEqual({ subtotal: 145, discount: 14.5, total: 130.5 }));
  it('caps an amount discount at the subtotal', () => expect(computeTotals(lines, { type: 'amount', value: 999 }).total).toBe(0));
  it('ignores negative discounts', () => expect(computeTotals(lines, { type: 'amount', value: -5 }).total).toBe(145));
});

describe('validatePayment', () => {
  it('rejects an empty cart', () => expect(validatePayment({ method: 'cash', total: 0, tendered: 100 }).ok).toBe(false));
  it('computes change for cash', () => expect(validatePayment({ method: 'cash', total: 85, tendered: 100 })).toEqual({ ok: true, change: 15 }));
  it('rejects insufficient cash', () => expect(validatePayment({ method: 'cash', total: 85, tendered: 50 }).ok).toBe(false));
  it('rejects non-numeric cash', () => expect(validatePayment({ method: 'cash', total: 85, tendered: 'abc' }).ok).toBe(false));
  it('requires a GCash reference', () => expect(validatePayment({ method: 'gcash', total: 85, reference: ' ' }).ok).toBe(false));
  it('accepts credit within limit', () => expect(validatePayment({ method: 'credit', total: 50, account: { balance: 100, limit: 200 } }).ok).toBe(true));
  it('rejects credit over limit', () => expect(validatePayment({ method: 'credit', total: 150, account: { balance: 100, limit: 200 } }).ok).toBe(false));
  it('rejects a disabled credit account', () => expect(validatePayment({ method: 'credit', total: 1, account: { balance: 0, limit: 200, active: false } }).ok).toBe(false));
});

describe('stock checks', () => {
  it('deducts recipe ingredients per meal', () => {
    const needs = computeStockNeeds([{ productId: 'rice', qty: 2 }, { productId: 'coke', qty: 1 }], products);
    expect(needs).toEqual({ products: { coke: 1 }, ingredients: { chk: 0.3, rc: 2 } });
  });
  it('flags insufficient ingredient stock', () => {
    const needs = computeStockNeeds([{ productId: 'rice', qty: 3 }], products);
    expect(findShortages(needs, products, ingredients)).toHaveLength(1);
  });
  it('flags insufficient product stock', () => {
    const needs = computeStockNeeds([{ productId: 'coke', qty: 4 }], products);
    expect(findShortages(needs, products, ingredients)[0]).toMatch(/Coke/);
  });
  it('flags archived, sold out and bad quantities', () => {
    const lines = [
      { productId: 'old', name: 'Old', qty: 1 },
      { productId: 'out', name: 'Out', qty: 1 },
      { productId: 'coke', name: 'Coke', qty: 1.5 },
      { productId: 'gone', name: 'Gone', qty: 1 },
    ];
    expect(findUnavailable(lines, products)).toHaveLength(4);
  });
  it('computes how many meals can be made', () => {
    expect(availableCount(products.rice, ingredients)).toBe(2);
    expect(availableCount(products.coke, ingredients)).toBe(3);
  });
});

import { linePricing, lineKey, componentIds } from '../src/lib/checkout';

describe('add-ons and meal sets', () => {
  const ing = { rice: { id: 'rice', name: 'Rice', stock: 10 }, egg: { id: 'egg', name: 'Egg', stock: 3 }, chk: { id: 'chk', name: 'Chicken', stock: 1 } };
  const prods = {
    adobo: { id: 'adobo', name: 'Adobo', price: 50, recipe: [{ ingredientId: 'chk', qty: 0.2 }, { ingredientId: 'rice', qty: 1 }], modifiers: [{ name: 'Extra rice', price: 10, recipe: [{ ingredientId: 'rice', qty: 1 }] }, { name: 'Egg', price: 15, recipe: [{ ingredientId: 'egg', qty: 1 }] }] },
    coke: { id: 'coke', name: 'Coke', price: 25, trackStock: true, stock: 4 },
    setA: { id: 'setA', name: 'Meal A', type: 'combo', price: 70, components: [{ productId: 'adobo', qty: 1 }, { productId: 'coke', qty: 1 }] },
  };
  it('prices add-ons from the product, not the cart', () => {
    expect(linePricing(prods.adobo, ['Extra rice', 'Egg'])).toEqual({ unitPrice: 75, modifiers: [{ name: 'Extra rice', price: 10 }, { name: 'Egg', price: 15 }] });
    expect(linePricing(prods.adobo, ['Lechon']).error).toMatch(/no longer offered/);
  });
  it('same product with different add-ons is a different cart line', () => {
    expect(lineKey('adobo', ['Egg', 'Extra rice'])).toBe(lineKey('adobo', ['Extra rice', 'Egg']));
    expect(lineKey('adobo', ['Egg'])).not.toBe(lineKey('adobo', []));
  });
  it('deducts add-on and meal-set stock', () => {
    const needs = computeStockNeeds([{ productId: 'adobo', qty: 2, modifiers: ['Extra rice'] }, { productId: 'setA', qty: 1 }], prods);
    expect(needs).toEqual({ products: { coke: 1 }, ingredients: { chk: 0.6, rice: 5 } });
  });
  it('meal-set availability follows its components', () => {
    expect(availableCount(prods.setA, ing, prods)).toBe(4); // coke 4, adobo limited by chicken 1/0.2 = 5
    expect(availableCount(prods.setA, ing, { ...prods, coke: { ...prods.coke, soldOut: true } })).toBe(0);
    expect(componentIds({ setA: prods.setA })).toEqual(['adobo', 'coke']);
  });
});

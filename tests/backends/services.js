// The app's real services (checkout, stock, credit, purchase orders, backup copy)
// running against a request-based database.
import { describe, it, expect } from 'vitest';



export function servicesSuite(name, makeDbFor, token) {
  describe(`${name}: app services`, async () => {
    const DB = await import('../../src/db/index.js');
    const { processSale } = await import('../../src/services/sales.js');
    const { changeStock } = await import('../../src/services/inventory.js');
    const { recordRepayment } = await import('../../src/services/credit.js');
    const P = await import('../../src/services/purchasing.js');
    const { readAllCollections, writeCollections } = await import('../../src/services/backup.js');
    const { processRefund } = await import('../../src/services/refunds.js');
    const SH = await import('../../src/services/shifts.js');
    const C = await import('../../src/services/counts.js');
    const { recordSupplierPayment } = await import('../../src/services/payables.js');
    const { runProductImport } = await import('../../src/services/productImport.js');
    const { planImport } = await import('../../src/lib/productImport.js');
    const { auth } = await import('../../src/firebase/index.js');
    auth.currentUser.getIdToken = async () => token('DEV');

    let dev;
    const profile = { id: 'staff1', displayName: 'Ana', role: 'admin' };
    const { doc, getDoc, setDoc, writeBatch, collection, getDocs, serverTimestamp } = DB;

    it('sets up an owner device and catalogue', async () => {
      dev = makeDbFor('DEV', 'svc');
      DB.setActiveDatabase(dev, { backend: dev.kind });
      const b = writeBatch(dev);
      b.set(doc(dev, 'users', 'DEV'), { email: 'dev@x', displayName: 'Dev', role: 'admin', active: true, createdAt: serverTimestamp() });
      b.set(doc(dev, 'settings', 'setup'), { ownerUid: 'DEV', createdAt: serverTimestamp() });
      await b.commit();
      await setDoc(doc(dev, 'ingredients', 'chk'), { name: 'Chicken', unit: 'kg', cost: 200, stock: 1, lowStock: 0.5, archived: false });
      await setDoc(doc(dev, 'products', 'meal'), { name: 'Chicken rice', price: 60, cost: 35, trackStock: false, recipe: [{ ingredientId: 'chk', qty: 0.25 }], archived: false, soldOut: false });
      await setDoc(doc(dev, 'products', 'coke'), { name: 'Coke', price: 25, cost: 18, trackStock: true, stock: 0, archived: false, soldOut: false, unit: 'bottle' });
      await setDoc(doc(dev, 'creditAccounts', 'stu1'), { name: 'Ben', idNumber: '2026-1', type: 'student', limit: 100, balance: 0, active: true });
      await setDoc(doc(dev, 'suppliers', 'sup1'), { name: 'Metro Drinks', active: true });
    });

    it('receives a purchase order in two deliveries', async () => {
      const po = await P.createPurchaseOrder({
        supplier: { id: 'sup1', name: 'Metro Drinks' },
        lines: [{ itemType: 'product', itemId: 'coke', name: 'Coke', unit: 'bottle', qty: '24', unitCost: '17.5' }, { itemType: 'ingredient', itemId: 'chk', name: 'Chicken', unit: 'kg', qty: '2', unitCost: '210' }],
        status: 'ordered',
        profile,
      });
      expect(po.poNo).toBe('PO-000001');
      expect(po.total).toBe(840);

      // first delivery: all the Coke, part of the chicken
      const d1 = await P.receiveDelivery({ poId: po.id, quantities: { 0: '24', 1: '0.5' }, referenceNo: 'SI-778', updateCost: true, profile });
      expect([d1.deliveryNo, d1.total, d1.poStatus]).toEqual(['DR-000001', 525, 'partial']);
      const coke = (await getDoc(doc(dev, 'products', 'coke'))).data();
      expect([coke.stock, coke.cost]).toEqual([24, 17.5]);

      // can't receive more than is still to come
      await expect(P.receiveDelivery({ poId: po.id, quantities: { 1: '5' }, profile })).rejects.toThrow(/still to come/);

      // second delivery completes the order
      const d2 = await P.receiveDelivery({ poId: po.id, quantities: { 1: '1.5' }, profile });
      expect([d2.deliveryNo, d2.poStatus]).toEqual(['DR-000002', 'received']);
      const saved = (await getDoc(doc(dev, 'purchaseOrders', po.id))).data();
      expect([saved.status, saved.receivedTotal, saved.deliveryCount, saved.items[1].receivedQty]).toEqual(['received', 840, 2, 2]);
      expect((await getDoc(doc(dev, 'ingredients', 'chk'))).data().stock).toBe(3);
      await expect(P.receiveDelivery({ poId: po.id, quantities: { 0: '1' }, profile })).rejects.toThrow(/already received/);

      const dels = await getDocs(collection(dev, 'deliveries'));
      expect(dels.docs.filter((x) => x.data().poId === po.id)).toHaveLength(2);
      const moves = await getDocs(collection(dev, 'stockMovements'));
      expect(moves.docs.filter((m) => m.data().poId === po.id)).toHaveLength(3);
    });

    it('records a delivery without a purchase order, and can close a PO short', async () => {
      const d = await P.receiveDelivery({ supplier: { id: 'sup1', name: 'Metro Drinks' }, lines: [{ itemType: 'ingredient', itemId: 'chk', name: 'Chicken', unit: 'kg', qty: '1', unitCost: '220' }], updateCost: false, profile });
      expect([d.deliveryNo, d.poNo, d.total]).toEqual(['DR-000003', '', 220]);
      const chk = (await getDoc(doc(dev, 'ingredients', 'chk'))).data();
      expect([chk.stock, chk.cost]).toEqual([4, 210]); // cost unchanged when asked

      const po2 = await P.createPurchaseOrder({ supplier: { id: 'sup1', name: 'Metro Drinks' }, lines: [{ itemType: 'ingredient', itemId: 'chk', name: 'Chicken', unit: 'kg', qty: '10', unitCost: '200' }], status: 'ordered', profile });
      const d4 = await P.receiveDelivery({ poId: po2.id, quantities: { 0: '4' }, closeOrder: true, profile });
      expect(d4.poStatus).toBe('received');
      expect((await getDoc(doc(dev, 'purchaseOrders', po2.id))).data().closedShort).toBe(true);
      expect((await getDoc(doc(dev, 'ingredients', 'chk'))).data().stock).toBe(8);
      // put chicken back to 2.5 kg for the checkout test below
      await changeStock({ itemType: 'ingredient', itemId: 'chk', change: -5.5, reason: 'adjust', note: 'test reset', profile });
    });

    it('checkout deducts recipe ingredients and blocks shortages', async () => {
      const r = await processSale({ saleId: 'sale-a', cart: [{ productId: 'meal', qty: 2 }, { productId: 'coke', qty: 3, price: 0.01 }], discount: { type: 'none' }, method: 'cash', tendered: '200', profile });
      expect(r.sale.total).toBe(195); // prices from the database, not the cart
      expect(r.sale.receiptNo).toBe('R-000001');
      expect((await getDoc(doc(dev, 'ingredients', 'chk'))).data().stock).toBe(2);
      expect((await getDoc(doc(dev, 'products', 'coke'))).data().stock).toBe(21);
      const again = await processSale({ saleId: 'sale-a', cart: [{ productId: 'meal', qty: 2 }], discount: { type: 'none' }, method: 'cash', tendered: '200', profile });
      expect(again.duplicate).toBe(true);
      await expect(processSale({ saleId: 'sale-b', cart: [{ productId: 'meal', qty: 9 }], discount: { type: 'none' }, method: 'cash', tendered: '999', profile })).rejects.toThrow(/Not enough stock/);
    });

    it('credit sale respects the limit; repayment lowers the balance', async () => {
      await processSale({ saleId: 'sale-c', cart: [{ productId: 'meal', qty: 1 }], discount: { type: 'none' }, method: 'credit', accountId: 'stu1', profile });
      await expect(processSale({ saleId: 'sale-d', cart: [{ productId: 'meal', qty: 1 }], discount: { type: 'none' }, method: 'credit', accountId: 'stu1', profile })).rejects.toThrow(/credit limit/);
      await expect(recordRepayment({ accountId: 'stu1', amount: 100, method: 'cash', profile })).rejects.toThrow(/more than the outstanding/);
      const r = await recordRepayment({ accountId: 'stu1', amount: 60, method: 'cash', profile });
      expect(r.after).toBe(0);
    });

    it('stock adjustments cannot go negative', async () => {
      await expect(changeStock({ itemType: 'product', itemId: 'coke', change: -100, reason: 'spoiled', profile })).rejects.toThrow(/cannot remove/);
      const r = await changeStock({ itemType: 'product', itemId: 'coke', change: -1, reason: 'spoiled', profile });
      expect(r.after).toBe(20);
    });

    it('sells add-ons and meal sets with the right stock', async () => {
      await setDoc(doc(dev, 'ingredients', 'egg'), { name: 'Egg', unit: 'pc', cost: 8, stock: 5, archived: false });
      await setDoc(doc(dev, 'products', 'adobo'), { name: 'Adobo', price: 50, cost: 30, trackStock: false, archived: false, soldOut: false,
        recipe: [{ ingredientId: 'chk', qty: 0.1 }], modifiers: [{ name: 'Egg', price: 15, recipe: [{ ingredientId: 'egg', qty: 1 }] }] });
      await setDoc(doc(dev, 'products', 'setA'), { name: 'Meal A', type: 'combo', price: 65, archived: false, soldOut: false, trackStock: false,
        components: [{ productId: 'adobo', qty: 1 }, { productId: 'coke', qty: 1 }] });
      const cokeBefore = (await getDoc(doc(dev, 'products', 'coke'))).data().stock;
      const r = await processSale({ saleId: 'sale-m', cart: [{ productId: 'adobo', qty: 2, modifiers: ['Egg'], price: 1 }, { productId: 'setA', qty: 1 }], discount: { type: 'none' }, method: 'cash', tendered: '500', profile });
      expect(r.sale.total).toBe(2 * 65 + 65);
      expect(r.sale.items[0].modifiers).toEqual([{ name: 'Egg', price: 15 }]);
      expect((await getDoc(doc(dev, 'ingredients', 'egg'))).data().stock).toBe(3);
      expect((await getDoc(doc(dev, 'products', 'coke'))).data().stock).toBe(cokeBefore - 1);
      await expect(processSale({ saleId: 'sale-x', cart: [{ productId: 'adobo', qty: 1, modifiers: ['Bacon'] }], discount: { type: 'none' }, method: 'cash', tendered: '99', profile }))
        .rejects.toThrow(/no longer offered/);
    });

    it('shift: sales, refund and pay-out add up to the expected cash', async () => {
      const shift = await SH.openShift({ openingCash: 500, profile });
      expect(shift.shiftNo).toBe('SH-000001');
      await expect(SH.openShift({ openingCash: 0, profile })).rejects.toThrow(/already have an open shift/);
      const sale = await processSale({ saleId: 'sale-s1', cart: [{ productId: 'coke', qty: 2 }], discount: { type: 'none' }, method: 'cash', tendered: '100', shiftId: shift.id, profile });
      const cokeAfterSale = (await getDoc(doc(dev, 'products', 'coke'))).data().stock;

      // refund one Coke: needs a manager, puts it back in stock, pays out cash
      await expect(processRefund({ saleId: 'sale-s1', picks: { 0: 1 }, reason: 'wrong item', restock: true, approver: { id: 's9', name: 'Cash', role: 'cashier' }, profile }))
        .rejects.toThrow(/manager or admin/);
      const rf = await processRefund({ saleId: 'sale-s1', picks: { 0: 1 }, reason: 'wrong item', restock: true, approver: { id: 'staff1', name: 'Ana', role: 'admin' }, shiftId: shift.id, profile });
      expect([rf.refundNo, rf.type, rf.amount, rf.cashAmount]).toEqual(['RF-000001', 'refund', 25, 25]);
      expect((await getDoc(doc(dev, 'products', 'coke'))).data().stock).toBe(cokeAfterSale + 1);
      await expect(processRefund({ saleId: 'sale-s1', picks: { 0: 2 }, reason: 'x', approver: { id: 'a', name: 'A', role: 'manager' }, profile })).rejects.toThrow(/only 1/);
      const s1 = (await getDoc(doc(dev, 'sales', 'sale-s1'))).data();
      expect([s1.refundedTotal, s1.refundStatus, s1.total]).toEqual([25, 'partial', sale.sale.total]);

      await SH.addCashEvent({ shiftId: shift.id, type: 'out', amount: 40, reason: 'ice', profile });
      const open = await SH.findOpenShift(profile.id);
      const closed = await SH.closeShift({ shift: open, counts: { 500: 1, 20: 1, 10: 1, 5: 1 }, profile });
      expect(closed.expectedCash).toBe(500 + 50 - 25 - 40);
      expect([closed.countedCash, closed.difference]).toEqual([535, 50]);
      expect(await SH.findOpenShift(profile.id)).toBeNull();
    });

    it('voids a credit sale: balance goes back down', async () => {
      await processSale({ saleId: 'sale-v', cart: [{ productId: 'coke', qty: 1 }], discount: { type: 'none' }, method: 'credit', accountId: 'stu1', profile });
      expect((await getDoc(doc(dev, 'creditAccounts', 'stu1'))).data().balance).toBe(25);
      const rf = await processRefund({ saleId: 'sale-v', picks: { 0: 1 }, reason: 'cancelled order', restock: false, approver: { id: 'm', name: 'Mae', role: 'manager' }, profile });
      expect([rf.type, rf.creditAmount, rf.cashAmount]).toEqual(['void', 25, 0]);
      expect((await getDoc(doc(dev, 'creditAccounts', 'stu1'))).data().balance).toBe(0);
    });

    it('stock count posts the differences', async () => {
      const coke = { id: 'coke', itemType: 'product', ...(await getDoc(doc(dev, 'products', 'coke'))).data() };
      const egg = { id: 'egg', itemType: 'ingredient', ...(await getDoc(doc(dev, 'ingredients', 'egg'))).data() };
      const count = await C.startCount({ items: [coke, egg], scopeLabel: 'Test', profile });
      expect(count.countNo).toBe('SC-000001');
      // a sale happens while counting: 1 coke
      await processSale({ saleId: 'sale-during-count', cart: [{ productId: 'coke', qty: 1 }], discount: { type: 'none' }, method: 'cash', tendered: '25', profile });
      const items = count.items.map((i) => ({ ...i, counted: i.itemId === 'coke' ? i.expected - 2 : null }));
      const v = await C.postCount({ count, items, profile });
      expect(v.changed).toBe(1);
      // counted 2 fewer than the snapshot; the sale during counting is kept too
      expect((await getDoc(doc(dev, 'products', 'coke'))).data().stock).toBe(coke.stock - 2 - 1);
      await expect(C.postCount({ count, items, profile })).rejects.toThrow(/already posted/);
    });

    it('expiry batches and supplier payments', async () => {
      await setDoc(doc(dev, 'suppliers', 'sup2'), { name: 'Farm Fresh', termsDays: 30, active: true });
      const d = await P.receiveDelivery({ supplier: { id: 'sup2', name: 'Farm Fresh' }, lines: [{ itemType: 'ingredient', itemId: 'egg', name: 'Egg', unit: 'pc', qty: '30', unitCost: '8', expiryDate: '2026-10-15' }], updateCost: false, profile });
      expect([d.paymentStatus, d.total, d.paidAmount]).toEqual(['unpaid', 240, 0]);
      expect(d.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const batches = (await getDocs(collection(dev, 'batches'))).docs.map((x) => ({ id: x.id, ...x.data() }));
      expect(batches).toHaveLength(1);
      const eggBefore = (await getDoc(doc(dev, 'ingredients', 'egg'))).data().stock;
      await C.closeBatch({ batch: batches[0], discardQty: 6, profile });
      expect((await getDoc(doc(dev, 'ingredients', 'egg'))).data().stock).toBe(eggBefore - 6);

      const dels = (await getDocs(collection(dev, 'deliveries'))).docs.map((x) => ({ id: x.id, ...x.data() }));
      await expect(recordSupplierPayment({ supplier: { id: 'sup2', name: 'Farm Fresh' }, deliveries: dels, amount: 999, method: 'cash', profile })).rejects.toThrow(/more than/);
      const pay = await recordSupplierPayment({ supplier: { id: 'sup2', name: 'Farm Fresh' }, deliveries: dels, amount: 100, method: 'gcash', reference: 'GC-1', profile });
      expect(pay.paymentNo).toBe('SP-000001');
      const after = (await getDoc(doc(dev, 'deliveries', d.id))).data();
      expect([after.paidAmount, after.paymentStatus]).toEqual([100, 'partial']);
    });

    it('expenses paid from the drawer count as cash out', async () => {
      const shift = await SH.openShift({ openingCash: 100, profile });
      await C.addExpense({ date: '2026-10-11', category: 'Gas / LPG', amount: 60, method: 'cash', paidTo: 'Petron', shift, fromDrawer: true, profile }, SH.addCashEvent);
      await expect(C.addExpense({ date: '2026-10-11', category: 'Other', amount: 0, profile }, SH.addCashEvent)).rejects.toThrow(/greater than zero/);
      const { summary } = await SH.shiftActivity(await SH.findOpenShift(profile.id));
      expect([summary.payOuts, summary.expectedCash]).toEqual([60, 40]);
      await SH.closeShift({ shift: await SH.findOpenShift(profile.id), counts: { 20: 2 }, profile });
    });

    it('out of stock: blocked unless the cashier confirms, then stock goes below zero', async () => {
      await setDoc(doc(dev, 'products', 'gum'), { name: 'Gum', price: 5, trackStock: true, stock: 1, lowStock: 2, archived: false, soldOut: false });
      await expect(processSale({ saleId: 'over-1', cart: [{ productId: 'gum', qty: 3 }], discount: { type: 'none' }, method: 'cash', tendered: '20', profile })).rejects.toThrow(/Not enough stock/);
      const r = await processSale({ saleId: 'over-1', cart: [{ productId: 'gum', qty: 3 }], discount: { type: 'none' }, method: 'cash', tendered: '20', profile, allowOversell: true });
      expect(r.sale.oversold[0]).toMatch(/Gum/);
      expect((await getDoc(doc(dev, 'products', 'gum'))).data().stock).toBe(-2);
      // a delivery of 10 brings it to the true count
      await setDoc(doc(dev, 'suppliers', 'sup3'), { name: 'Sari', active: true });
      await P.receiveDelivery({ supplier: { id: 'sup3', name: 'Sari' }, lines: [{ itemType: 'product', itemId: 'gum', name: 'Gum', qty: '10', unitCost: '3' }], profile });
      expect((await getDoc(doc(dev, 'products', 'gum'))).data().stock).toBe(8);
    });

    it('imports products from a spreadsheet plan', async () => {
      const existing = (await getDocs(collection(dev, 'products'))).docs.map((x) => ({ id: x.id, ...x.data() }));
      const cats = (await getDocs(collection(dev, 'categories'))).docs.map((x) => ({ id: x.id, ...x.data() }));
      const plan = planImport([
        { line: 2, name: 'Mango Juice', category: 'Juices', type: 'Drink', price: 30, trackStock: 'Yes', stock: 12, barcode: '4800000000017' },
        { line: 3, name: 'Coke', price: 26 },
      ], { products: existing, categories: cats });
      expect(plan.errors).toEqual([]);
      const r = await runProductImport(plan, profile);
      expect([r.created, r.updated, r.categories]).toEqual([1, 1, 1]);
      const all = (await getDocs(collection(dev, 'products'))).docs.map((x) => x.data());
      const mango = all.find((p) => p.name === 'Mango Juice');
      expect([mango.stock, mango.barcode, mango.trackStock]).toEqual([12, '4800000000017', true]);
      expect(all.find((p) => p.name === 'Coke').price).toBe(26);
    });

    it('offline sale is recorded even if stock ran out, and flagged', async () => {
      await setDoc(doc(dev, 'products', 'chips'), { name: 'Chips', price: 20, trackStock: true, stock: 1, archived: false, soldOut: false });
      const r = await processSale({ saleId: 'off-1', cart: [{ productId: 'chips', name: 'Chips', qty: 3, price: 18 }], discount: { type: 'none' }, method: 'cash', tendered: '60', profile,
        offline: { at: '2026-10-11T03:00:00.000Z', tempNo: 'OFF-1' } });
      expect([r.sale.total, r.sale.needsReview]).toEqual([54, true]);
      expect(r.sale.reviewNotes.join(' ')).toMatch(/price now 20/);
      expect(r.sale.reviewNotes.join(' ')).toMatch(/Stock ran out/);
      expect((await getDoc(doc(dev, 'products', 'chips'))).data().stock).toBe(-2);
      const again = await processSale({ saleId: 'off-1', cart: [{ productId: 'chips', qty: 3, price: 18 }], discount: { type: 'none' }, method: 'cash', tendered: '60', profile, offline: { at: 'x', tempNo: 'OFF-1' } });
      expect(again.duplicate).toBe(true);
    });

    it('copies everything into another empty database keeping IDs', async () => {
      const target = makeDbFor('DEV', 'copy');
      const b = writeBatch(target);
      b.set(doc(target, 'users', 'DEV'), { email: 'dev@x', displayName: 'Dev', role: 'admin', active: true });
      b.set(doc(target, 'settings', 'setup'), { ownerUid: 'DEV' });
      await b.commit();
      const all = await readAllCollections(dev);
      const { written } = await writeCollections(target, all, { skipUid: 'DEV' });
      expect(written).toBeGreaterThan(10);
      const copy = await readAllCollections(target);
      expect(copy.sales.map((s) => s.id).sort()).toEqual(all.sales.map((s) => s.id).sort());
      expect(copy.purchaseOrders.map((p) => p.data.poNo).sort()).toEqual(['PO-000001', 'PO-000002']);
      for (const [name, docs] of Object.entries(all)) {
        if (name !== 'users') expect([name, copy[name].length]).toEqual([name, docs.length]);
      }
      expect(copy.sales[0].data.createdAt.toDate()).toBeInstanceOf(Date);
    });
  });
}

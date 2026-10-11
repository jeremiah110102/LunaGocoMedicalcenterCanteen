import { db, collection, doc, runTransaction, serverTimestamp, updateDoc } from '../db';
import { round2 } from '../lib/checkout';
import { logAudit } from '../lib/audit';
import { addDays } from '../lib/inventoryMath';

export const PO_STATUS = { draft: 'Draft', ordered: 'Ordered', partial: 'Partly received', received: 'Received', cancelled: 'Cancelled' };
export const OPEN_STATUSES = ['draft', 'ordered', 'partial'];
const COLLECTION_FOR = { product: 'products', ingredient: 'ingredients' };
export const poNumber = (n) => `PO-${String(n).padStart(6, '0')}`;
export const deliveryNumber = (n) => `DR-${String(n).padStart(6, '0')}`;
const EPS = 1e-9;
/** How much of a PO line is still to come. */
export const remainingQty = (l) => round2(Math.max(Number(l.qty) - (Number(l.receivedQty) || 0), 0));

/** Cleans PO lines and returns { items, total } or throws a readable error. */
export function cleanLines(lines) {
  const items = [];
  const seen = new Set();
  for (const l of lines) {
    if (!l.itemId) continue;
    const key = `${l.itemType}:${l.itemId}`;
    if (seen.has(key)) throw new Error(`${l.name} is listed twice. Combine the quantities into one line.`);
    seen.add(key);
    const qty = round2(Number(l.qty));
    const unitCost = round2(Number(l.unitCost));
    if (!(qty > 0)) throw new Error(`Enter a quantity for ${l.name}.`);
    if (!(unitCost >= 0) || l.unitCost === '') throw new Error(`Enter the unit cost for ${l.name}.`);
    items.push({ itemType: l.itemType, itemId: l.itemId, name: l.name, unit: l.unit || '', qty, unitCost, lineTotal: round2(qty * unitCost), ...(l.expiryDate ? { expiryDate: l.expiryDate } : {}) });
  }
  if (!items.length) throw new Error('Add at least one item.');
  return { items, total: round2(items.reduce((t, i) => t + i.lineTotal, 0)) };
}

export async function createPurchaseOrder({ supplier, lines, notes = '', expectedDate = '', status = 'draft', profile }) {
  if (!supplier) throw new Error('Choose a supplier.');
  const { items, total } = cleanLines(lines);
  const ref = doc(collection(db, 'purchaseOrders'));
  const counterRef = doc(db, 'counters', 'purchaseOrders');
  const po = await runTransaction(db, async (tx) => {
    const c = await tx.get(counterRef);
    const next = c.exists() ? Number(c.data().next) + 1 : 1;
    if (c.exists()) tx.update(counterRef, { next });
    else tx.set(counterRef, { next });
    const data = {
      poNo: poNumber(next),
      supplierId: supplier.id,
      supplierName: supplier.name,
      status,
      items,
      total,
      notes: String(notes).trim(),
      expectedDate,
      createdById: profile.id,
      createdByName: profile.displayName || '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      ...(status === 'ordered' ? { orderedAt: serverTimestamp() } : {}),
    };
    tx.set(ref, data);
    return { id: ref.id, ...data };
  });
  await logAudit(profile, 'po.create', { poId: ref.id, poNo: po.poNo, supplier: supplier.name, total, status });
  return po;
}

export async function updateDraft(po, { supplier, lines, notes, expectedDate }, profile) {
  if (po.status !== 'draft') throw new Error('Only draft purchase orders can be edited.');
  const { items, total } = cleanLines(lines);
  await updateDoc(doc(db, 'purchaseOrders', po.id), {
    supplierId: supplier.id, supplierName: supplier.name, items, total,
    notes: String(notes || '').trim(), expectedDate: expectedDate || '', updatedAt: serverTimestamp(),
  });
  await logAudit(profile, 'po.update', { poId: po.id, poNo: po.poNo, total });
}

export async function setStatus(po, status, profile) {
  // received = "close order" for a partly received PO (no more deliveries expected)
  const allowed = { ordered: ['draft'], cancelled: ['draft', 'ordered'], received: ['partial'] };
  if (!allowed[status]?.includes(po.status)) throw new Error(`A ${PO_STATUS[po.status].toLowerCase()} order can't be marked ${PO_STATUS[status].toLowerCase()}.`);
  await updateDoc(doc(db, 'purchaseOrders', po.id), {
    status,
    updatedAt: serverTimestamp(),
    ...(status === 'ordered' ? { orderedAt: serverTimestamp() } : {}),
    ...(status === 'cancelled' ? { cancelledAt: serverTimestamp(), cancelledByName: profile.displayName || '' } : {}),
    ...(status === 'received' ? { receivedAt: serverTimestamp(), closedShort: true, closedByName: profile.displayName || '' } : {}),
  });
  await logAudit(profile, status === 'received' ? 'po.closed' : `po.${status}`, { poId: po.id, poNo: po.poNo });
}

/**
 * Records one delivery, in a single transaction:
 *  • creates a delivery record (DR-000001) with what arrived, its cost and who received it
 *  • adds the stock and writes stock movements (optionally updates item costs)
 *  • for a PO: adds to each line's received quantity; the PO becomes "Partly received"
 *    until every line has arrived (or closeOrder is set), then "Received".
 *
 * With poId: quantities = { [poLineIndex]: qtyArrivingNow }.
 * Without poId (delivery not on a PO): supplier + lines [{ itemType, itemId, name, unit, qty, unitCost }].
 */
export async function receiveDelivery({ poId, quantities = {}, expiries = {}, supplier, lines, referenceNo = '', notes = '', updateCost = true, closeOrder = false, profile }) {
  const poRef = poId ? doc(db, 'purchaseOrders', poId) : null;
  const counterRef = doc(db, 'counters', 'deliveries');
  const deliveryRef = doc(collection(db, 'deliveries'));
  // A delivery without a PO is checked up front (it doesn't depend on stored data).
  const direct = poId ? null : cleanLines(lines || []);
  if (!poId && !supplier) throw new Error('Choose a supplier.');

  const result = await runTransaction(db, async (tx) => {
    const [poSnap, counterSnap] = await Promise.all([poRef ? tx.get(poRef) : null, tx.get(counterRef)]);
    let po = null;
    let arriving;
    if (poRef) {
      if (!poSnap.exists()) throw new Error('Purchase order not found.');
      po = { id: poId, ...poSnap.data() };
      if (!OPEN_STATUSES.includes(po.status)) throw new Error(`This order is already ${PO_STATUS[po.status].toLowerCase()}.`);
      arriving = po.items.map((l, i) => {
        const raw = quantities[i];
        const q = round2(Number(raw === undefined || raw === '' ? 0 : raw));
        if (!(q >= 0)) throw new Error(`Invalid quantity for ${l.name}.`);
        if (q > remainingQty(l) + EPS) throw new Error(`${l.name}: only ${remainingQty(l)} ${l.unit || ''} still to come on this order.`.replace(' .', '.'));
        return { ...l, index: i, qty: q, lineTotal: round2(q * l.unitCost), expiryDate: expiries[i] || '' };
      });
    } else {
      arriving = direct.items.map((l) => ({ ...l }));
    }
    const items = arriving.filter((l) => l.qty > 0);
    if (!items.length) throw new Error('Nothing received. Enter at least one quantity.');

    const refs = items.map((l) => doc(db, COLLECTION_FOR[l.itemType], l.itemId));
    const supplierId = po ? po.supplierId : supplier.id;
    const [supplierSnap, ...snaps] = await Promise.all([tx.get(doc(db, 'suppliers', supplierId)), ...refs.map((r) => tx.get(r))]);
    const termsDays = supplierSnap.exists() ? Number(supplierSnap.data().termsDays) || 0 : 0;

    // ---- writes ----
    const next = counterSnap.exists() ? Number(counterSnap.data().next) + 1 : 1;
    if (counterSnap.exists()) tx.update(counterRef, { next });
    else tx.set(counterRef, { next });
    const deliveryNo = deliveryNumber(next);
    const supplierName = po ? po.supplierName : supplier.name;

    items.forEach((l, i) => {
      if (!snaps[i].exists()) throw new Error(`${l.name} no longer exists.`);
      const item = snaps[i].data();
      const after = round2((Number(item.stock) || 0) + l.qty);
      tx.update(refs[i], { stock: after, ...(updateCost ? { cost: l.unitCost } : {}), updatedAt: serverTimestamp() });
      tx.set(doc(collection(db, 'stockMovements')), {
        itemType: l.itemType,
        itemId: l.itemId,
        itemName: item.name,
        change: l.qty,
        stockAfter: after,
        reason: 'receive',
        note: [deliveryNo, po?.poNo, supplierName, referenceNo && `ref ${referenceNo}`].filter(Boolean).join(' · '),
        deliveryId: deliveryRef.id,
        ...(po ? { poId } : {}),
        byId: profile.id,
        byName: profile.displayName || '',
        createdAt: serverTimestamp(),
      });
    });

    const total = round2(items.reduce((t, l) => t + l.lineTotal, 0));
    const delivery = {
      deliveryNo,
      poId: po ? poId : '',
      poNo: po ? po.poNo : '',
      supplierId,
      supplierName,
      referenceNo: String(referenceNo).trim(),
      notes: String(notes).trim(),
      items: items.map(({ itemType, itemId, name, unit, qty, unitCost, lineTotal, expiryDate }) => ({ itemType, itemId, name, unit: unit || '', qty, unitCost, lineTotal, ...(expiryDate ? { expiryDate } : {}) })),
      total,
      paidAmount: 0,
      paymentStatus: total > 0 ? 'unpaid' : 'paid',
      dueDate: addDays(new Date(), termsDays),
      costUpdated: !!updateCost,
      receivedById: profile.id,
      receivedByName: profile.displayName || '',
      receivedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
    };
    tx.set(deliveryRef, delivery);
    // Items with an expiry date become batches, so the Inventory page can warn before they expire.
    items.filter((l) => l.expiryDate).forEach((l) => {
      tx.set(doc(collection(db, 'batches')), {
        itemType: l.itemType, itemId: l.itemId, name: l.name, unit: l.unit || '', qty: l.qty,
        expiryDate: l.expiryDate, deliveryId: deliveryRef.id, deliveryNo, supplierName,
        status: 'open', createdAt: serverTimestamp(),
      });
    });

    let poStatus = null;
    if (po) {
      const updated = po.items.map((l, i) => ({ ...l, receivedQty: round2((Number(l.receivedQty) || 0) + arriving[i].qty) }));
      const complete = updated.every((l) => remainingQty(l) <= EPS);
      poStatus = complete || closeOrder ? 'received' : 'partial';
      tx.update(poRef, {
        items: updated,
        status: poStatus,
        receivedTotal: round2((Number(po.receivedTotal) || 0) + total),
        deliveryCount: (Number(po.deliveryCount) || 0) + 1,
        lastDeliveryAt: serverTimestamp(),
        ...(poStatus === 'received' ? { receivedAt: serverTimestamp(), receivedByName: profile.displayName || '', ...(complete ? {} : { closedShort: true }) } : {}),
        updatedAt: serverTimestamp(),
      });
    }
    return { id: deliveryRef.id, ...delivery, receivedAt: new Date(), poStatus };
  });
  await logAudit(profile, 'delivery.receive', {
    deliveryId: result.id, deliveryNo: result.deliveryNo, poNo: result.poNo, supplier: result.supplierName, total: result.total, poStatus: result.poStatus || '',
  });
  return result;
}

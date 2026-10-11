import { useEffect } from 'react';
import { APP } from '../config/app';
import { PAYMENT_METHODS } from '../lib/checkout';
import { fmtDateTime, peso, qty } from '../lib/format';
import { getDeviceSettings } from '../lib/deviceSettings';
import { Modal } from './ui';

const addOns = (it) => (it.modifiers || []).filter((m) => m && m.name);

export function Receipt({ sale }) {
  const dev = getDeviceSettings();
  const number = sale.receiptNo || sale.offlineNo;
  return (
    <div className={`receipt paper-${dev.paperWidth} ${dev.largeText ? 'receipt-large' : ''}`} id="receipt">
      <div className="r-center">
        <strong className="r-title">{APP.canteenName}</strong>
        <div>{APP.address}</div>
      </div>
      <div className="r-rule" />
      <div className="r-row"><span>Receipt</span><span>{number}</span></div>
      <div className="r-row"><span>Date</span><span>{fmtDateTime(sale.offlineAt || sale.createdAt)}</span></div>
      <div className="r-row"><span>Cashier</span><span>{sale.cashierName}</span></div>
      {sale.pendingSync && <div className="r-center">** OFFLINE — will sync **</div>}
      <div className="r-rule" />
      {sale.items.map((it, i) => (
        <div key={i} className="r-item">
          <div>{it.name}</div>
          {addOns(it).map((m) => <div key={m.name} className="r-addon">+ {m.name}{m.price ? ` ${peso(m.price)}` : ''}</div>)}
          <div className="r-row"><span>{qty(it.qty)} × {peso(it.price)}</span><span>{peso(it.lineTotal ?? it.price * it.qty)}</span></div>
        </div>
      ))}
      <div className="r-rule" />
      <div className="r-row"><span>Subtotal</span><span>{peso(sale.subtotal)}</span></div>
      {sale.discount > 0 && (
        <div className="r-row">
          <span>Discount{sale.discountType === 'percent' ? ` (${sale.discountValue}%)` : ''}</span>
          <span>−{peso(sale.discount)}</span>
        </div>
      )}
      <div className="r-row r-total"><span>TOTAL</span><span>{peso(sale.total)}</span></div>
      <div className="r-row"><span>Paid by</span><span>{PAYMENT_METHODS[sale.paymentMethod]}</span></div>
      {sale.paymentMethod === 'cash' && (
        <>
          <div className="r-row"><span>Cash</span><span>{peso(sale.tendered)}</span></div>
          <div className="r-row"><span>Change</span><span>{peso(sale.change)}</span></div>
        </>
      )}
      {sale.paymentMethod === 'gcash' && <div className="r-row"><span>Ref #</span><span>{sale.reference}</span></div>}
      {sale.paymentMethod === 'credit' && <div className="r-row"><span>Account</span><span>{sale.creditAccountName}</span></div>}
      {sale.refundedTotal > 0 && (
        <>
          <div className="r-rule" />
          <div className="r-row"><span>{sale.refundStatus === 'full' ? 'VOIDED / REFUNDED' : 'Refunded'}</span><span>−{peso(sale.refundedTotal)}</span></div>
        </>
      )}
      <div className="r-rule" />
      <div className="r-center">{APP.receiptFooter}</div>
    </div>
  );
}

/** Big-print order slip for the kitchen: what to prepare, no prices. */
export function KitchenSlip({ sale }) {
  const dev = getDeviceSettings();
  const number = sale.receiptNo || sale.offlineNo || '';
  return (
    <div className={`receipt kitchen-slip paper-${dev.paperWidth}`} id="kitchen-slip">
      <div className="r-center"><strong>KITCHEN ORDER</strong></div>
      <div className="k-number">#{number.slice(-4)}</div>
      <div className="r-center small">{fmtDateTime(sale.offlineAt || sale.createdAt)} · {sale.cashierName}</div>
      <div className="r-rule" />
      {sale.items.map((it, i) => (
        <div key={i} className="k-item">
          <strong>{qty(it.qty)} × {it.name}</strong>
          {addOns(it).map((m) => <div key={m.name}>  + {m.name}</div>)}
        </div>
      ))}
    </div>
  );
}

export function ReceiptModal({ sale, onClose, onNew, actions, fresh = false }) {
  const dev = getDeviceSettings();
  useEffect(() => {
    if (!fresh || !dev.autoPrint) return undefined;
    const t = setTimeout(() => window.print(), 350);
    return () => clearTimeout(t);
  }, [fresh, dev.autoPrint]);

  return (
    <Modal
      title={`Receipt ${sale.receiptNo || sale.offlineNo}`}
      onClose={onClose}
      footer={
        <>
          {actions}
          <button className="btn" onClick={() => window.print()}>Print{dev.kitchenSlip ? ' receipt + kitchen slip' : ' receipt'}</button>
          {onNew ? <button className="btn btn-primary" onClick={onNew}>New sale</button> : <button className="btn btn-primary" onClick={onClose}>Close</button>}
        </>
      }
    >
      {sale.needsReview && (
        <div className="alert alert-warn">Recorded after being offline — please review:{'\n'}{(sale.reviewNotes || []).join('\n')}</div>
      )}
      <Receipt sale={sale} />
      {dev.kitchenSlip && <KitchenSlip sale={sale} />}
    </Modal>
  );
}

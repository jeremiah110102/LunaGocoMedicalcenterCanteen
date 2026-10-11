import { APP } from '../config/app';

const money = new Intl.NumberFormat(APP.locale, { style: 'currency', currency: APP.currency });

export const peso = (n) => money.format(Number(n) || 0);

export const toDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === 'function') return v.toDate();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const fmtDateTime = (v) => {
  const d = toDate(v);
  return d ? d.toLocaleString(APP.locale, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
};

export const fmtDate = (v) => {
  const d = toDate(v);
  return d ? d.toLocaleDateString(APP.locale, { dateStyle: 'medium' }) : '—';
};

export const dayKey = (v) => {
  const d = toDate(v);
  if (!d) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export const startOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const endOfDay = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

export const qty = (n) => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
};

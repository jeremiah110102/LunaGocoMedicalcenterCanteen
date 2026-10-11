import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Field, Modal, useToast } from './ui';
import { pinProblem, PIN_MAX, PIN_MIN } from '../lib/pin';

const pinInput = (value, set) => (
  <input type="password" inputMode="numeric" autoComplete="off" maxLength={PIN_MAX} value={value} onChange={(e) => set(e.target.value.replace(/\D/g, ''))} required />
);

/** Lets the signed-in staff member change their own PIN. */
export default function ChangePin({ onClose }) {
  const { changeOwnPin } = useAuth();
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setErr('');
    const p = pinProblem(next);
    if (p) return setErr(p);
    if (next !== next2) return setErr('The new PINs don’t match.');
    if (next === cur) return setErr('Choose a PIN different from your current one.');
    setBusy(true);
    try {
      await changeOwnPin(cur, next);
      toast('Your PIN was changed.');
      onClose();
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Change my PIN" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="cpin" disabled={busy}>Save PIN</button></>}>
      <form id="cpin" onSubmit={save} className="stack">
        {err && <div className="alert alert-error">{err}</div>}
        <Field label="Current PIN">{pinInput(cur, setCur)}</Field>
        <Field label={`New PIN (${PIN_MIN}–${PIN_MAX} digits)`}>{pinInput(next, setNext)}</Field>
        <Field label="Confirm new PIN">{pinInput(next2, setNext2)}</Field>
      </form>
    </Modal>
  );
}

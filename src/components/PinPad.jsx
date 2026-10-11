import { useEffect } from 'react';
import { PIN_MAX } from '../lib/pin';

/** On-screen number pad that also accepts the keyboard. */
export default function PinPad({ value, onChange, onSubmit, disabled, max = PIN_MAX }) {
  const press = (k) => {
    if (disabled) return;
    if (k === 'back') onChange(value.slice(0, -1));
    else if (k === 'clear') onChange('');
    else if (value.length < max) onChange(value + k);
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('back');
      else if (e.key === 'Escape') press('clear');
      else if (e.key === 'Enter') onSubmit?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="pinpad">
      <div className="pin-dots" aria-label={`${value.length} digits entered`}>
        {Array.from({ length: max }, (_, i) => <span key={i} className={i < value.length ? 'is-on' : ''} />)}
      </div>
      <div className="pin-keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'].map((k) => (
          <button key={k} type="button" className={`pin-key ${k.length > 1 ? 'pin-key-fn' : ''}`} onClick={() => press(k)} disabled={disabled} aria-label={k === 'back' ? 'Delete' : k === 'clear' ? 'Clear' : k}>
            {k === 'back' ? '⌫' : k === 'clear' ? 'C' : k}
          </button>
        ))}
      </div>
    </div>
  );
}

import { describe, it, expect } from 'vitest';
import { pinProblem, pinFields, verifyPin, registerFailure, lockoutLeft, MAX_ATTEMPTS } from '../src/lib/pin';

describe('pinProblem', () => {
  it('accepts 4–6 digit PINs', () => {
    expect(pinProblem('4821')).toBe('');
    expect(pinProblem('905513')).toBe('');
  });
  it('rejects bad PINs', () => {
    for (const p of ['', '12a4', '123', '1234567', '1111', '1234', '6543']) expect(pinProblem(p)).not.toBe('');
  });
});

describe('hashing', () => {
  it('verifies the right PIN only and never stores it', async () => {
    const f = await pinFields('4821');
    expect(JSON.stringify(f)).not.toContain('4821');
    expect(await verifyPin('4821', f)).toBe(true);
    expect(await verifyPin('4822', f)).toBe(false);
    expect(await verifyPin('4821', {})).toBe(false);
  });
  it('uses a different salt each time', async () => {
    const a = await pinFields('4821');
    const b = await pinFields('4821');
    expect(a.pinHash).not.toBe(b.pinHash);
  });
});

describe('lockout', () => {
  it('locks after too many wrong PINs, then resets', () => {
    let s;
    const t = 1_000_000;
    for (let i = 0; i < MAX_ATTEMPTS; i++) s = registerFailure(s, t);
    expect(lockoutLeft(s, t)).toBe(60);
    expect(lockoutLeft(s, t + 61_000)).toBe(0);
    expect(registerFailure(s, t + 61_000).fails).toBe(1);
  });
});

import { makeDebouncer } from '../src/lib/scanner';
describe('scan debounce', () => {
  it('ignores the same code seen again within 1.5 s, but not a different one', () => {
    const ok = makeDebouncer(1500);
    expect(ok('480001', 0)).toBe(true);
    expect(ok('480001', 500)).toBe(false);
    expect(ok('480002', 600)).toBe(true);
    expect(ok('480001', 700)).toBe(true);
    expect(ok('480001', 2300)).toBe(true);
  });
});

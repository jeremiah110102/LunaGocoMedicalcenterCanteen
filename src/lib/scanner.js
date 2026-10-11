// Camera barcode/QR scanning that works on any modern device, plus scan sounds.
// Uses the browser's built-in BarcodeDetector when it exists (Chrome on Android,
// ChromeOS, macOS); otherwise a bundled ZXing engine (iPhone/iPad Safari, Firefox,
// Windows). The engine file ships with the app, so scanning also works offline.

const FORMATS = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'data_matrix'];
let detectorPromise = null;

async function nativeDetector() {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = FORMATS.filter((f) => supported.includes(f));
    return formats.length ? new window.BarcodeDetector({ formats }) : null;
  } catch {
    return null;
  }
}

async function bundledDetector() {
  const [{ BarcodeDetector, prepareZXingModule }, { default: wasmUrl }] = await Promise.all([
    import('barcode-detector/ponyfill'),
    import('zxing-wasm/reader/zxing_reader.wasm?url'),
  ]);
  prepareZXingModule({ overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) } });
  return new BarcodeDetector({ formats: FORMATS });
}

/** A detector with .detect(videoOrImage) → [{ rawValue, format }]. */
export function getDetector() {
  detectorPromise ??= nativeDetector().then((d) => d || bundledDetector());
  return detectorPromise;
}

/** Downloads the scanning engine in the background (so camera scanning also works offline later). */
export function warmScanner() {
  if (typeof window === 'undefined' || !navigator.onLine) return;
  const go = () => {
    import('barcode-detector/ponyfill').catch(() => {});
    import('zxing-wasm/reader/zxing_reader.wasm?url').then(({ default: url }) => fetch(url).catch(() => {})).catch(() => {});
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(go, { timeout: 8000 });
  else setTimeout(go, 3000);
}

export const cameraAvailable = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
export const secureForCamera = () => typeof window === 'undefined' || window.isSecureContext;

/** Ignores the same code read again within `ms` (a camera sees a barcode many times per second). */
export function makeDebouncer(ms = 1500) {
  let last = '';
  let at = 0;
  return (code, now = Date.now()) => {
    if (code === last && now - at < ms) return false;
    last = code;
    at = now;
    return true;
  };
}

/* ---------------- sounds ---------------- */
let ctx = null;
/** Call from a tap/click so phones (especially iPhones) allow sound later. */
export function unlockAudio() {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    /* no audio */
  }
}
function tone(freq, ms, { type = 'square', vol = 0.08, delay = 0 } = {}) {
  try {
    unlockAudio();
    if (!ctx) return;
    const t = ctx.currentTime + delay / 1000;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(t);
    o.stop(t + ms / 1000 + 0.02);
  } catch {
    /* no audio */
  }
}
/** Item added. */
export const beepOk = () => tone(1760, 90);
/** Added, but stock is low or out. */
export const beepWarn = () => {
  tone(990, 110);
  tone(740, 160, { delay: 130 });
};
/** Code not found. */
export const beepError = () => tone(200, 320, { type: 'sawtooth', vol: 0.1 });
/** Short vibration on phones that support it. */
export const buzz = (ms = 40) => {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* ignore */
  }
};

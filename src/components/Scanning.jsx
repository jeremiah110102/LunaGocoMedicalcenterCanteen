import { useEffect, useRef, useState } from 'react';
import { Modal } from './ui';
import { cameraAvailable, getDetector, makeDebouncer, secureForCamera } from '../lib/scanner';
import { onQueueChange, pendingSales } from '../services/offline';

/**
 * USB/Bluetooth barcode scanners "type" the code very fast and press Enter.
 * This listens for that pattern anywhere on the page (except while typing in a field).
 */
export function useScanner(onScan) {
  const ref = useRef(onScan);
  ref.current = onScan;
  useEffect(() => {
    let buf = '';
    let last = 0;
    const onKey = (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
      const now = Date.now();
      if (now - last > 80) buf = '';
      last = now;
      if (e.key === 'Enter') {
        if (buf.length >= 3) {
          e.preventDefault();
          ref.current(buf);
        }
        buf = '';
      } else if (e.key.length === 1) {
        buf += e.key;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export const cameraScanSupported = () => cameraAvailable();

/**
 * Camera scanner for QR codes and barcodes, on any device with a camera.
 *  continuous: keep scanning after each read (cashier mode); otherwise close after one.
 *  onDetected(code) may return { ok, text } to show feedback under the video.
 *  paused: stop reading while something else needs attention (e.g. a stock warning).
 */
export function CameraScanner({ onDetected, onClose, title = 'Scan with camera', continuous = false, paused = false }) {
  const video = useRef(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const handler = useRef(onDetected);
  handler.current = onDetected;
  const [facing, setFacing] = useState('environment');
  const [err, setErr] = useState(() => (!cameraAvailable() ? 'This device or browser has no camera access. Use a USB/Bluetooth scanner or type the code.' : !secureForCamera() ? 'The camera only works on a secure (https://) address. Open the app from its https:// link.' : ''));
  const [status, setStatus] = useState('Starting camera…');
  const [feed, setFeed] = useState([]);

  useEffect(() => {
    if (err) return undefined;
    let stream;
    let timer;
    let stopped = false;
    const seen = makeDebouncer(1500);
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        if (stopped) return;
        video.current.srcObject = stream;
        video.current.setAttribute('playsinline', 'true');
        await video.current.play();
        setStatus('Loading scanner…');
        const detector = await getDetector();
        setStatus('Point the camera at a barcode or QR code');
        const tick = async () => {
          if (stopped) return;
          if (!pausedRef.current && video.current?.readyState >= 2) {
            try {
              const found = await detector.detect(video.current);
              const code = found[0]?.rawValue?.trim();
              if (code && seen(code)) {
                const r = (await handler.current(code)) || {};
                setFeed((f) => [{ code, ok: r.ok !== false, text: r.text || code, at: Date.now() }, ...f].slice(0, 5));
                if (!continuous) return;
              }
            } catch {
              /* frame not ready */
            }
          }
          timer = setTimeout(tick, 180);
        };
        tick();
      } catch (e) {
        setErr(e?.name === 'NotAllowedError' ? 'Camera permission was denied. Allow the camera for this site in the browser settings, then try again.' : 'Couldn’t open the camera. Close other apps using it and try again.');
      }
    })();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [facing, continuous, err]);

  return (
    <Modal title={title} onClose={onClose}
      footer={<>
        {!err && <button className="btn" onClick={() => setFacing((f) => (f === 'environment' ? 'user' : 'environment'))}>Switch camera</button>}
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      </>}>
      {err ? <div className="alert alert-warn">{err}</div> : (
        <div className="camera-wrap">
          <video ref={video} className="camera" muted playsInline autoPlay />
          <div className="camera-frame" aria-hidden />
          <div className="camera-status">{paused ? 'Paused' : status}</div>
        </div>
      )}
      {feed.length > 0 && (
        <ul className="scan-feed">
          {feed.map((f) => <li key={f.at} className={f.ok ? 'ok' : 'bad'}>{f.ok ? '✓' : '✕'} {f.text}</li>)}
        </ul>
      )}
      {continuous && <p className="muted small">Keeps scanning — each scan adds the item. Tap Done when finished.</p>}
    </Modal>
  );
}

/** Online state and the number of sales waiting to be sent. */
export function useOfflineQueue() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [queue, setQueue] = useState(() => (typeof window === 'undefined' ? [] : pendingSales()));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    const stop = onQueueChange(() => setQueue(pendingSales()));
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      stop();
    };
  }, []);
  return { online, queue };
}

// Product photos — only when the database is Supabase (bucket "product-images",
// created by supabase/schema.sql). Uploads use the Firebase sign-in, which the
// storage policies check against approved device accounts.
import { auth } from '../firebase';
import { backend, connection } from './index';

const BUCKET = 'product-images';
const MAX_BYTES = 10 * 1024 * 1024;

export const imagesEnabled = () => backend === 'supabase';

/** Shrinks a photo to at most `max` px on its longest side, as JPEG. */
async function shrink(file, max = 640) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not read this image.'))), 'image/jpeg', 0.85));
}

export async function uploadProductImage(file) {
  if (!imagesEnabled()) throw new Error('Product photos need the Supabase database (Settings → Database).');
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file (JPG, PNG, WebP…).');
  if (file.size > MAX_BYTES) throw new Error('That image is larger than 10 MB.');
  const blob = await shrink(file);
  const path = `products/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const token = await auth.currentUser?.getIdToken();
  const res = await fetch(`${connection.supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { apikey: connection.supabaseKey, Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'cache-control': '31536000' },
    body: blob,
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    if (res.status === 400 && /bucket/i.test(msg)) throw new Error('The product-images bucket is missing. Run supabase/schema.sql again in Supabase.');
    if (res.status === 401 || res.status === 403) throw new Error('Supabase refused the upload. Check Third-party Auth (Firebase) and run supabase/schema.sql again.');
    throw new Error(`Upload failed (${res.status}). ${msg.slice(0, 120)}`);
  }
  return { imageUrl: `${connection.supabaseUrl}/storage/v1/object/public/${BUCKET}/${path}`, imagePath: path };
}

/** Best effort: removing an old photo never blocks saving the product. */
export async function deleteProductImage(path) {
  if (!path || !imagesEnabled()) return;
  try {
    const token = await auth.currentUser?.getIdToken();
    await fetch(`${connection.supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'DELETE',
      headers: { apikey: connection.supabaseKey, Authorization: `Bearer ${token}` },
    });
  } catch {
    /* ignore */
  }
}

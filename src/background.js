import { waitUntil } from '@vercel/functions';

// Work that should finish after the response is sent, such as delivering a WhatsApp
// message. On Vercel, waitUntil keeps the function alive until it settles; elsewhere the
// promise simply runs on.
export function background(promise) {
  const p = Promise.resolve(promise).catch(err => console.error('[background]', err));
  try { waitUntil(p); } catch { /* not running on Vercel */ }
  return p;
}

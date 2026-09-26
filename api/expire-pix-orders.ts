import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Runs every minute (Vercel Cron, see vercel.json). Cancels PIX orders that
// were never paid within the payment window, cancelling the Mercado Pago
// charge too. Safety net for customers who close the page without cancelling.
const PAYMENT_WINDOW_MS = 5 * 60 * 1000;

function parseServiceAccount(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch (jsonErr) {
    try {
      return JSON.parse(Buffer.from(trimmed, 'base64').toString('utf-8'));
    } catch {
      throw new Error(
        `FIREBASE_SERVICE_ACCOUNT_KEY is not valid JSON or base64-encoded JSON: ${(jsonErr as Error).message}`
      );
    }
  }
}

function getAdminApp() {
  const existing = getApps();
  if (existing.length > 0) return existing[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY is not configured');
  return initializeApp({ credential: cert(parseServiceAccount(raw)) });
}

export default async function handler(_req: any, res: any) {
  try {
    const db = getFirestore(getAdminApp());
    const cutoff = Date.now() - PAYMENT_WINDOW_MS;
    const stale = await db
      .collection('pix_test_orders')
      .where('status', '==', 'pending_payment')
      .get();

    const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    let cancelled = 0;

    for (const docSnap of stale.docs) {
      const order = docSnap.data() as any;
      if (order.paymentMethod !== 'pix' || order.paidAt || !((order.pixCreatedAt || order.createdAt) < cutoff)) continue;

      if (order.mpPaymentId && accessToken) {
        const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
        const check = await fetch(`https://api.mercadopago.com/v1/payments/${order.mpPaymentId}`, { headers });
        const payment: any = await check.json();
        if (check.ok && payment.status === 'approved') continue; // webhook will handle it
        if (check.ok && payment.status === 'pending') {
          await fetch(`https://api.mercadopago.com/v1/payments/${order.mpPaymentId}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ status: 'cancelled' }),
          });
        }
      }

      await docSnap.ref.update({ status: 'cancelled', mpStatus: 'cancelled', updatedAt: Date.now() });
      cancelled++;
    }

    res.status(200).json({ checked: stale.size, cancelled });
  } catch (err: any) {
    console.error('expire-pix-orders error', err);
    res.status(500).json({ error: err?.message || 'Internal error' });
  }
}

import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

// Lets the customer cancel their own unpaid PIX order (button, or when the
// 5-minute payment window runs out). Verifies the caller's Firebase ID token
// so nobody can cancel someone else's order, and re-checks with Mercado Pago
// that the charge is still unpaid before cancelling anything, so a payment
// that lands at the last second is never thrown away.
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

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { orderId, idToken } = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (!orderId || typeof orderId !== 'string' || !idToken || typeof idToken !== 'string') {
      res.status(400).json({ error: 'orderId and idToken are required' });
      return;
    }

    const app = getAdminApp();
    const decoded = await getAuth(app).verifyIdToken(idToken);

    const db = getFirestore(app);
    const orderRef = db.collection('pix_test_orders').doc(orderId);
    const snap = await orderRef.get();
    if (!snap.exists) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    const order = snap.data() as any;
    if (order.userId !== decoded.uid) {
      res.status(403).json({ error: 'Not your order' });
      return;
    }
    if (order.paymentMethod !== 'pix' || order.status !== 'pending_payment' || order.paidAt) {
      res.status(409).json({ error: 'Order can no longer be cancelled', status: order.status });
      return;
    }

    const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (order.mpPaymentId && accessToken) {
      const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
      const check = await fetch(`https://api.mercadopago.com/v1/payments/${order.mpPaymentId}`, { headers });
      const payment: any = await check.json();
      if (check.ok && payment.status === 'approved') {
        // Paid at the last moment — let the webhook move it forward instead.
        res.status(409).json({ error: 'Payment already confirmed', paid: true });
        return;
      }
      if (check.ok && payment.status === 'pending') {
        await fetch(`https://api.mercadopago.com/v1/payments/${order.mpPaymentId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ status: 'cancelled' }),
        });
      }
    }

    await orderRef.update({ status: 'cancelled', mpStatus: 'cancelled', updatedAt: Date.now() });
    res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error('cancel-pix-order error', err);
    res.status(500).json({ error: err?.message || 'Internal error' });
  }
}

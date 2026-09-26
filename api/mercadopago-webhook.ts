import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

// Mercado Pago calls this URL every time a payment's status changes. The
// notification body only ever carries a payment id — it must never be
// trusted for the actual status (anyone could POST a fake "approved" body
// here), so this always re-fetches the payment from Mercado Pago's own API
// with our access token before touching the order.
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
    // Mercado Pago's webhook config test uses a GET — answer it so the
    // dashboard shows the URL as reachable.
    res.status(200).json({ ok: true });
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const paymentId = body?.data?.id || req.query?.['data.id'] || req.query?.id;
    const topic = body?.type || req.query?.type || req.query?.topic;

    if (topic !== 'payment' || !paymentId) {
      // Mercado Pago also pings other topics (merchant_order, etc.) —
      // acknowledge and ignore anything that isn't a payment update.
      res.status(200).json({ ignored: true });
      return;
    }

    const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (!accessToken) {
      console.error('MERCADOPAGO_ACCESS_TOKEN is not configured');
      res.status(200).json({ error: 'not configured' });
      return;
    }

    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payment: any = await mpRes.json();
    if (!mpRes.ok) {
      console.error('Failed to fetch payment from Mercado Pago', payment);
      res.status(200).json({ error: 'could not verify payment' });
      return;
    }

    const orderId = payment.external_reference;
    if (!orderId) {
      res.status(200).json({ ignored: true, reason: 'no external_reference' });
      return;
    }

    const app = getAdminApp();
    const db = getFirestore(app);
    const orderRef = db.collection('pix_test_orders').doc(orderId);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) {
      res.status(200).json({ ignored: true, reason: 'order not found' });
      return;
    }

    const update: Record<string, unknown> = {
      mpStatus: payment.status,
      mpPaymentId: String(payment.id),
      updatedAt: Date.now(),
    };

    // Only ever move a still-pending order forward — never let a late or
    // retried webhook drag an order that's already further along (or was
    // cancelled) backwards.
    if (payment.status === 'approved' && orderSnap.data()?.status === 'pending_payment') {
      update.status = 'preparing';
      update.paidAt = Date.now();
    }

    await orderRef.update(update);

    // PIX orders are hidden from admins until paid, so the push that a normal
    // order sends at creation is sent here instead, the moment payment lands.
    if (update.status === 'preparing') {
      try {
        const order = orderSnap.data() as any;
        const adminsSnap = await db.collection('users').where('role', '==', 'admin').get();
        const tokens: string[] = [];
        adminsSnap.forEach((d) => {
          const t = d.data().fcmTokens;
          if (Array.isArray(t)) tokens.push(...t.filter((x) => typeof x === 'string'));
        });
        if (tokens.length > 0) {
          const value = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(order.total || 0);
          await getMessaging(app).sendEachForMulticast({
            tokens,
            notification: {
              title: 'PIX confirmado — novo pedido pago!',
              body: `${order.userName || 'Cliente'} — ${value}`,
            },
            data: { orderId },
          });
        }
      } catch (pushErr) {
        console.error('push after PIX confirmation failed', pushErr);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error('mercadopago-webhook error', err);
    // Still 200 — Mercado Pago retries aggressively on non-2xx responses,
    // and a bug on our side shouldn't turn into a notification hammering loop.
    res.status(200).json({ error: err?.message || 'Internal error' });
  }
}

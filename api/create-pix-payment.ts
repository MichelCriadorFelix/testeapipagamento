import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Vercel serverless function. Called by the client right after a PIX order
// is created: creates a dynamic PIX charge on Mercado Pago (tied to this
// exact order's amount and id via external_reference) and writes the QR
// code / copia-e-cola straight onto the order doc, so the order page's
// existing onSnapshot listener picks it up automatically.
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
    const { orderId, amount, description, payerEmail } =
      typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});

    if (!orderId || typeof orderId !== 'string') {
      res.status(400).json({ error: 'orderId is required' });
      return;
    }
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      res.status(400).json({ error: 'amount must be a positive number' });
      return;
    }

    const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    if (!accessToken) {
      res.status(500).json({ error: 'MERCADOPAGO_ACCESS_TOKEN is not configured' });
      return;
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const notificationUrl = `https://${host}/api/mercadopago-webhook`;

    const mpRes = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        // Stops Mercado Pago from creating a duplicate charge if this
        // request gets retried (network hiccup, double submit, etc.).
        'X-Idempotency-Key': orderId,
      },
      body: JSON.stringify({
        transaction_amount: Math.round(amount * 100) / 100,
        description: description || `Pedido ${orderId}`,
        payment_method_id: 'pix',
        // Phone-only accounts carry an internal pseudo-email
        // (…@sg-phone.internal) that Mercado Pago rejects, so anything that
        // isn't a normal-looking address falls back to a generic one.
        payer: {
          email:
            typeof payerEmail === 'string' && /^[^\s@]+@[^\s@]+\.(com|com\.br|net|org|br)$/i.test(payerEmail)
              ? payerEmail
              : 'cliente@sensacaogourmet.com.br',
        },
        // Charge expires shortly after the 5-minute payment window, so an
        // order cancelled for non-payment can never be paid afterwards.
        date_of_expiration: new Date(Date.now() + 6 * 60 * 1000).toISOString().replace('Z', '+00:00'),
        external_reference: orderId,
        notification_url: notificationUrl,
      }),
    });

    const mpData: any = await mpRes.json();
    if (!mpRes.ok) {
      console.error('Mercado Pago error', mpData);
      res.status(mpRes.status).json({ error: mpData.message || 'Falha ao criar pagamento PIX no Mercado Pago', details: mpData });
      return;
    }

    const txData = mpData.point_of_interaction?.transaction_data;
    if (!txData?.qr_code) {
      console.error('Mercado Pago response missing PIX QR data', mpData);
      res.status(502).json({ error: 'Mercado Pago não retornou os dados do QR Code PIX', details: mpData });
      return;
    }

    const app = getAdminApp();
    const db = getFirestore(app);
    await db.collection('pix_test_orders').doc(orderId).set(
      {
        mpPaymentId: String(mpData.id),
        mpStatus: mpData.status,
        pixQrCode: txData.qr_code_base64,
        pixCopiaECola: txData.qr_code,
      },
      { merge: true }
    );

    res.status(200).json({
      paymentId: mpData.id,
      qrCodeBase64: txData.qr_code_base64,
      copiaECola: txData.qr_code,
      status: mpData.status,
    });
  } catch (err: any) {
    console.error('create-pix-payment error', err);
    res.status(500).json({ error: err?.message || 'Internal error' });
  }
}

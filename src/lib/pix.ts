// Fire-and-forget call right after a PIX order is created. The serverless
// function creates the charge on Mercado Pago and writes the QR code /
// copia-e-cola straight onto the order doc — the order page picks it up
// automatically via its existing onSnapshot listener, so nothing here needs
// to be awaited before navigating away from checkout.
export async function createPixPayment(orderId: string, amount: number, payerEmail?: string) {
  try {
    const res = await fetch('/api/create-pix-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, amount, payerEmail, description: `Pedido ${orderId.slice(-6).toUpperCase()}` }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error('Failed to create PIX payment', data);
    }
  } catch (e) {
    console.error('Failed to create PIX payment', e);
  }
}

export const PIX_PAYMENT_WINDOW_MS = 5 * 60 * 1000;

// Customer cancels their own unpaid PIX order (button, or when the 5-minute
// payment window runs out). The server re-checks ownership and that the
// charge is still unpaid, so this is safe to call more than once.
export async function cancelPixOrder(orderId: string, reason?: 'expired'): Promise<boolean> {
  try {
    const { auth } = await import('./firebase');
    const idToken = await auth.currentUser?.getIdToken();
    if (!idToken) return false;
    const res = await fetch('/api/cancel-pix-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, idToken, reason }),
    });
    return res.ok;
  } catch (e) {
    console.error('Failed to cancel PIX order', e);
    return false;
  }
}

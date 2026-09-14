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

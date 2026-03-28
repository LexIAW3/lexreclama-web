'use strict';

/**
 * Stripe payment service.
 * Factory function injects config, shared state (Maps), and utilities.
 */

function createStripeService({
  stripeSecretKey,
  stripeApi,
  fetchWithTimeout,
  paidClaimTypes,
  getBaseUrl,
  pendingCheckoutLeads,
  completedCheckoutLeads,
  pendingCheckoutTtlMs,
  completedCheckoutTtlMs,
}) {
  async function createStripeCheckoutSession(req, leadToken, leadData) {
    if (!stripeSecretKey) throw new Error('STRIPE_SECRET_KEY no configurada');
    const paidConfig = paidClaimTypes[leadData.tipo];
    if (!paidConfig) throw new Error('Tipo no soportado para pago inicial');

    const origin = getBaseUrl(req);
    const successUrl = `${origin}/?checkout=success&lead=${encodeURIComponent(leadToken)}&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${origin}/?checkout=cancel&lead=${encodeURIComponent(leadToken)}`;

    const form = new URLSearchParams();
    form.append('mode', 'payment');
    form.append('success_url', successUrl);
    form.append('cancel_url', cancelUrl);
    form.append('payment_method_types[0]', 'card');
    form.append('line_items[0][quantity]', '1');
    form.append('line_items[0][price_data][currency]', 'eur');
    form.append('line_items[0][price_data][unit_amount]', String(paidConfig.grossAmountCents));
    form.append('line_items[0][price_data][product_data][name]', `LexReclama · ${leadData.tipoLabel}`);
    form.append('line_items[0][price_data][product_data][description]', `Honorarios iniciales orientativos: ${paidConfig.baseAmountLabel}`);
    form.append('metadata[leadToken]', leadToken);
    form.append('metadata[leadType]', leadData.tipo);
    form.append('metadata[leadEmail]', leadData.email);
    form.append('customer_email', leadData.email);
    form.append('locale', 'es');

    const stripeRes = await fetchWithTimeout(`${stripeApi}/checkout/sessions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    const stripeData = await stripeRes.json();
    if (!stripeRes.ok) {
      const stripeMessage = stripeData?.error?.message || `Stripe error HTTP ${stripeRes.status}`;
      throw new Error(stripeMessage);
    }
    return stripeData;
  }

  async function readStripeCheckoutSession(sessionId) {
    if (!stripeSecretKey) throw new Error('STRIPE_SECRET_KEY no configurada');
    const stripeRes = await fetchWithTimeout(`${stripeApi}/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: {
        'Authorization': `Bearer ${stripeSecretKey}`,
      },
    });
    const stripeData = await stripeRes.json();
    if (!stripeRes.ok) {
      const stripeMessage = stripeData?.error?.message || `Stripe error HTTP ${stripeRes.status}`;
      throw new Error(stripeMessage);
    }
    return stripeData;
  }

  function sweepPendingCheckoutLeads() {
    const now = Date.now();
    for (const [leadToken, pending] of pendingCheckoutLeads) {
      if (now - pending.createdAtMs > pendingCheckoutTtlMs) {
        pendingCheckoutLeads.delete(leadToken);
      }
    }
    for (const [leadToken, completed] of completedCheckoutLeads) {
      if (now - completed.completedAtMs > completedCheckoutTtlMs) {
        completedCheckoutLeads.delete(leadToken);
      }
    }
  }

  return {
    createStripeCheckoutSession,
    readStripeCheckoutSession,
    sweepPendingCheckoutLeads,
  };
}

module.exports = { createStripeService };
